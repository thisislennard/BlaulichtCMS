/** Zahl mit einer Nachkommastelle im deutschen Format (Komma), z. B. für „580,9 GB frei“. */
export const de1 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
