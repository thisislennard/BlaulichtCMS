import { describe, expect, it } from 'vitest';
import { cleanLine, cleanText, decodeWords, htmlToText, parseAddressList, parseMail, parseParams, sanitizeHtml } from '../src/press/mime.js';
import { imapSearchDate, parseImapDate } from '../src/press/imap.js';
import { ignoreReason } from '../src/press/mailbox.js';
import { pressMessageId } from '../src/press/send.js';
import { configuredSender, ownSenderAddresses, parseMailbox } from '../src/lib/mail-address.js';

/** MIME-Leser und Einordnung des Presse-Postfachs (#205) – ohne Datenbank. */

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

describe('MIME-Leser', () => {
  it('RFC 2047: B und Q, Zeichensätze, benachbarte Wörter, rohes UTF-8', () => {
    expect(decodeWords('=?UTF-8?Q?Anfrage_zum_Gro=C3=9Fbrand?=')).toBe('Anfrage zum Großbrand');
    expect(decodeWords('=?iso-8859-1?Q?M=FCller?= <m@x.de>')).toBe('Müller <m@x.de>');
    expect(decodeWords('=?UTF-8?B?w4RyZ2Vy?= =?UTF-8?B?IG1pdCBkZW0=?= Wetter')).toBe('Ärger mit dem Wetter');
    // Mehrbytezeichen über zwei Wörter verteilt
    expect(decodeWords('=?UTF-8?B?ww==?= =?UTF-8?B?pA==?=')).toBe('ä');
    expect(decodeWords('=?windows-1252?Q?=80_5?=')).toBe('€ 5');
    expect(decodeWords(Buffer.from('Grüße', 'utf8').toString('latin1'))).toBe('Grüße');
    expect(decodeWords('Kein =?x-unbekannt?Q?Test?= Problem')).toBe('Kein Test Problem');
  });

  it('Parameter nach RFC 2231 und Adresslisten', () => {
    expect(parseParams(`attachment; filename*=UTF-8''Pressemitteilung%20%C3%84nderung.pdf`).params.filename).toBe('Pressemitteilung Änderung.pdf');
    expect(parseParams(`attachment; filename*0*=UTF-8''Lange%20; filename*1="Datei.pdf"`).params.filename).toBe('Lange Datei.pdf');
    expect(parseParams('text/plain; charset="ISO-8859-1"; format=flowed')).toEqual({ value: 'text/plain', params: { charset: 'ISO-8859-1', format: 'flowed' } });
    expect(parseAddressList('"Presse, Paula" <Paula@Zeitung.example>, radio@example.org (Radio Muster), =?UTF-8?Q?J=C3=B6rg?= <j@x.de>')).toEqual([
      { name: 'Presse, Paula', address: 'paula@zeitung.example' },
      { name: 'Radio Muster', address: 'radio@example.org' },
      { name: 'Jörg', address: 'j@x.de' },
    ]);
    expect(parseAddressList('Redaktion: a@b.de, c@d.de;')).toEqual([{ name: '', address: 'a@b.de' }, { name: '', address: 'c@d.de' }]);
  });

  it('multipart mit Text, HTML, Anhang (base64) und quoted-printable', () => {
    const pdf = Buffer.from('%PDF-1.4\n%äöü\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const raw = crlf(`From: =?UTF-8?Q?Paula_M=C3=BCller?= <paula@zeitung.example>
To: presse@feuerwehr.example
Subject: =?UTF-8?Q?Anfrage_Gro=C3=9Fbrand?=
Message-ID: <abc123@zeitung.example>
In-Reply-To: <out-1@blaulichtcms.example>
References: <a@x> <out-1@blaulichtcms.example>
Date: Mon, 16 Nov 2026 08:15:00 +0100
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: multipart/alternative; boundary="b2"

--b2
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Guten Tag,=0Awie viele Kr=C3=A4fte waren im Einsatz? Eine sehr lange Zeile, die=
 umbrochen wurde.
--b2
Content-Type: text/html; charset=utf-8

<p>Guten Tag</p><script>alert(1)</script>
--b2--
--b1
Content-Type: application/pdf; name="Fragen.pdf"
Content-Disposition: attachment; filename="Fragen.pdf"
Content-Transfer-Encoding: base64

${pdf.toString('base64').replace(/(.{40})/g, '$1\n')}
--b1--
`);
    const m = parseMail(Buffer.from(raw, 'utf8'));
    expect(m.subject).toBe('Anfrage Großbrand');
    expect(m.from).toEqual({ name: 'Paula Müller', address: 'paula@zeitung.example' });
    expect(m.to).toEqual([{ name: '', address: 'presse@feuerwehr.example' }]);
    expect(m.messageId).toBe('<abc123@zeitung.example>');
    expect(m.inReplyTo).toBe('<out-1@blaulichtcms.example>');
    expect(m.references).toEqual(['<a@x>', '<out-1@blaulichtcms.example>']);
    expect(m.date?.toISOString()).toBe('2026-11-16T07:15:00.000Z');
    expect(m.text).toBe('Guten Tag,\nwie viele Kräfte waren im Einsatz? Eine sehr lange Zeile, die umbrochen wurde.');
    expect(m.html).toContain('<p>Guten Tag</p>');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ filename: 'Fragen.pdf', contentType: 'application/pdf', inline: false });
    expect(m.attachments[0].content.equals(pdf)).toBe(true);
  });

  it('einfache Mail in Latin-1 ohne MIME-Kopf, nur HTML, fehlende Abschlussgrenze', () => {
    const latin = Buffer.concat([Buffer.from('Subject: Test\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'), Buffer.from('Grüße aus der Redaktion', 'latin1')]);
    expect(parseMail(latin).text).toBe('Grüße aus der Redaktion');
    const htmlOnly = parseMail(Buffer.from(crlf('Subject: x\nContent-Type: text/html\n\n<div>Zeile&nbsp;1<br>Zeile 2</div><a href="https://example.org/a">Link</a>')));
    expect(htmlOnly.text).toBe('Zeile 1\nZeile 2\nLink (https://example.org/a)');
    const broken = parseMail(Buffer.from(crlf('Content-Type: multipart/mixed; boundary=zz\n\n--zz\nContent-Type: text/plain\n\nRest ohne Ende')));
    expect(broken.text).toBe('Rest ohne Ende');
    expect(parseMail(Buffer.from('kaputt')).subject).toBe('');
  });

  it('HTML wird entschärft und in Text umgewandelt', () => {
    const r = sanitizeHtml(`<p onclick="x()" style="color:red">Hallo <img src="https://tracker.example/p.gif"><img src="data:image/png;base64,AAAA"><a href="javascript:alert(1)">böse</a> <a href="https://ok.example" target="_self">gut</a></p><script>alert(1)</script><style>body{}</style><iframe src="https://x"></iframe><svg onload="x()"></svg><form action="https://x"><input></form>`);
    expect(r.html).not.toMatch(/script|onclick|iframe|javascript:|<svg|<form|<input|tracker\.example|<style/i);
    expect(r.html).toContain('style="color:red"');
    expect(r.html).toContain('src="data:image/png;base64,AAAA"');
    expect(r.html).toContain('href="https://ok.example" target="_blank" rel="noopener noreferrer nofollow"');
    expect(r.blockedImages).toBe(1);
    expect(sanitizeHtml('<div style="background:url(https://x/y.png)">a</div>').html).toBe('<div>a</div>');
    expect(htmlToText('<style>p{}</style><p>A &amp; B</p><ul><li>eins</li><li>zwei</li></ul>')).toBe('A & B\n• eins\n• zwei');
  });

  it('IMAP-Datum', () => {
    expect(parseImapDate('17-Jul-1996 02:44:25 -0700')?.toISOString()).toBe('1996-07-17T09:44:25.000Z');
    expect(parseImapDate(' 1-Feb-2026 10:00:00 +0100')?.toISOString()).toBe('2026-02-01T09:00:00.000Z');
    expect(imapSearchDate(new Date('2026-11-05T12:00:00Z'))).toBe('5-Nov-2026');
  });
});

describe('Einordnen: automatische Antworten, Spam, Massenmails', () => {
  const mail = (headers: string, subject = 'Frage', from = 'a@zeitung.example') => parseMail(Buffer.from(crlf(`From: ${from}\nSubject: ${subject}\n${headers}\n\nText`)));
  it('erkennt und lässt normale Mails durch', () => {
    expect(ignoreReason(mail(''), [])).toBeNull();
    expect(ignoreReason(mail('Auto-Submitted: auto-replied'), [])?.outcome).toBe('auto');
    expect(ignoreReason(mail('Auto-Submitted: no'), [])).toBeNull();
    expect(ignoreReason(mail('X-Autoreply: yes'), [])?.outcome).toBe('auto');
    expect(ignoreReason(mail('', 'Automatische Antwort: Frage'), [])?.outcome).toBe('auto');
    expect(ignoreReason(mail('', 'AW: Abwesenheitsnotiz'), [])?.outcome).toBe('auto');
    expect(ignoreReason(mail('', 'Frage', 'MAILER-DAEMON@mx.example'), [])?.outcome).toBe('auto');
    expect(ignoreReason(mail('Content-Type: multipart/report; report-type=delivery-status; boundary=x'), [])?.outcome).toBe('auto');
    expect(ignoreReason(mail('X-Spam-Flag: YES'), [])?.outcome).toBe('spam');
    expect(ignoreReason(mail('X-Spam-Status: Yes, score=9.1'), [])?.outcome).toBe('spam');
    expect(ignoreReason(mail('X-MS-Exchange-Organization-SCL: 7'), [])?.outcome).toBe('spam');
    expect(ignoreReason(mail('X-MS-Exchange-Organization-SCL: 1'), [])).toBeNull();
    expect(ignoreReason(mail('List-Unsubscribe: <https://x>'), [])?.outcome).toBe('bulk');
    expect(ignoreReason(mail('Precedence: bulk'), [])?.outcome).toBe('bulk');
    expect(ignoreReason(mail('', 'Frage', 'presse@feuerwehr.example'), ['presse@feuerwehr.example'])?.outcome).toBe('own');
  });
});

describe('Kodierte Namen mit Komma (#229)', () => {
  it('erst aufteilen, dann dekodieren', () => {
    expect(parseAddressList('=?iso-8859-1?Q?M=FCller=2C_Hans?= <h@x.de>, b@c.de')).toEqual([
      { name: 'Müller, Hans', address: 'h@x.de' },
      { name: '', address: 'b@c.de' },
    ]);
    expect(parseAddressList('=?UTF-8?Q?M=C3=BCller=2C_Hans?= <h@x.de>, b@c.de')).toEqual([
      { name: 'Müller, Hans', address: 'h@x.de' },
      { name: '', address: 'b@c.de' },
    ]);
    // auch ;, <, ", ( im kodierten Namen; Base64; kodiertes Wort (regelwidrig) in Anführungszeichen
    const b64 = Buffer.from('Redaktion; Lokales <Info>').toString('base64');
    expect(parseAddressList(`=?UTF-8?B?${b64}?= <r@x.de>; "=?UTF-8?Q?Nach=2C_Vor?=" <n@x.de>`)).toEqual([
      { name: 'Redaktion; Lokales <Info>', address: 'r@x.de' },
      { name: 'Nach, Vor', address: 'n@x.de' },
    ]);
    expect(parseAddressList('r@x.de (=?UTF-8?Q?Radio=2C_Musterstadt?=)')).toEqual([{ name: 'Radio, Musterstadt', address: 'r@x.de' }]);
  });

  it('From-Kopf in parseMail', () => {
    const m = parseMail(Buffer.from(crlf('From: =?UTF-8?Q?M=C3=BCller=2C_Hans?= <hans@zeitung.example>\nTo: =?iso-8859-1?Q?Presse=2C_Feuerwehr?= <presse@feuerwehr.example>, b@c.de\nSubject: Frage\n\nText')));
    expect(m.from).toEqual({ name: 'Müller, Hans', address: 'hans@zeitung.example' });
    expect(m.to.map((a) => a.address)).toEqual(['presse@feuerwehr.example', 'b@c.de']);
  });
});

describe('Steuerzeichen aus Fremdtext (#237)', () => {
  it('NUL aus Betreff, Text, HTML, Namen und Dateinamen entfernt', () => {
    const html = Buffer.from('<p>A\u0000B</p>').toString('base64');
    const raw = crlf(`From: =?UTF-8?Q?Pa=00ula?= <paula@zeitung.example>
Subject: =?UTF-8?Q?Test=00X?=
Message-ID: <nul@zeitung.example>
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hallo=00Welt=07!
--b1
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

${html}
--b1
Content-Type: application/pdf
Content-Disposition: attachment; filename*=UTF-8''Datei%00.pdf

JVBERi0=
--b1--
`);
    const m = parseMail(Buffer.from(raw, 'utf8'));
    expect(m.subject).toBe('TestX');
    expect(m.from).toEqual({ name: 'Paula', address: 'paula@zeitung.example' });
    expect(m.text).toBe('HalloWelt!');
    expect(m.html).toBe('<p>AB</p>');
    expect(m.attachments[0].filename).toBe('Datei_.pdf');
    expect(JSON.stringify({ ...m, headers: [...m.headers], attachments: [] })).not.toMatch(/\\u0000/);
    expect(cleanText('a\u0000b\tc\r\nd\u001f\u007f')).toBe('ab\tc\r\nd');
    expect(cleanLine('a\r\nb\u0000')).toBe('a b');
  });
});

describe('Absender mit Anzeigenamen (#230)', () => {
  it('parseMailbox, Message-ID und eigene Adressen', () => {
    expect(parseMailbox('Feuerwehr Musterstadt <Presse@Example.org>')).toEqual({ address: 'Presse@Example.org', name: 'Feuerwehr Musterstadt' });
    expect(parseMailbox('"Feuerwehr, Presse" <presse@example.org>')).toEqual({ address: 'presse@example.org', name: 'Feuerwehr, Presse' });
    expect(parseMailbox(' presse@example.org ')).toEqual({ address: 'presse@example.org', name: '' });
    expect(parseMailbox('Feuerwehr Musterstadt')).toBeNull();
    expect(parseMailbox('')).toBeNull();
    expect(pressMessageId('Feuerwehr Musterstadt <presse@Example.org>', 'pm')).toMatch(/^<pm-[0-9a-f-]{36}@example\.org>$/);
    expect(pressMessageId('presse@example.org')).toMatch(/@example\.org>$/);
    expect(pressMessageId('kaputt')).toMatch(/@blaulichtcms\.invalid>$/);
    expect(configuredSender({ 'mail.transport': 'smtp', 'smtp.from': 'Feuerwehr <presse@example.org>', 'm365.sender': '' })).toEqual({ address: 'presse@example.org', name: 'Feuerwehr' });
    expect(configuredSender({ 'mail.transport': 'm365', 'smtp.from': 'x@y.de', 'm365.sender': 'm365@example.org' })?.address).toBe('m365@example.org');
    const own = ownSenderAddresses({ 'smtp.from': 'Feuerwehr Musterstadt <Presse@Feuerwehr.example>', 'm365.sender': '' });
    expect(own).toEqual(['presse@feuerwehr.example']);
    const m = parseMail(Buffer.from(crlf('From: Feuerwehr Musterstadt <presse@feuerwehr.example>\nSubject: Pressemitteilung\n\nText')));
    expect(ignoreReason(m, own)?.outcome).toBe('own');
  });
});
