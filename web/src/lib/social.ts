/**
 * Soziale Netzwerke in der Oberfläche. Zählregeln, Höchstlängen und der gesendete Text kommen aus demselben Code wie auf
 * dem Server (server/src/lib/social-text.ts, #262) – Zeichenzähler und Vorschau je Netzwerk kürzen genau wie beim Senden.
 */
import type { SocialChannel } from '../../../server/src/lib/social-text';

export { FORMAT_LABEL, SOCIAL_LABEL, BLUESKY_MAX, BLUESKY_MAX_BYTES, blueskyLength, channelLength, channelMax, contentWarning, limitsFor, mastodonLength, SOCIAL_KINDS, socialText, socialTextTooLong, STORY_KINDS, threadsLength, xLength } from '../../../server/src/lib/social-text';
export type { RevText, TextLimits } from '../../../server/src/lib/social-text';

export type SocialKind = SocialChannel;
