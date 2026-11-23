import type { IndexedMessage } from './ingest';

export interface AuthSummary {
  spf: string;
  dkim: string;
  dmarc: string;
  dmarcPolicy: string | null;
}

export interface SpamVerdict {
  score: number;
  verdict: 'ham' | 'spam' | 'quarantine';
  reasons: string[];
}

export const SPAM_THRESHOLD = 5;

/**
 * Lightweight rule-based scoring. Authentication failures dominate; DMARC
 * failures under a p=reject policy are held in quarantine for an admin.
 */
export function scoreMessage(auth: AuthSummary | null, msg: IndexedMessage): SpamVerdict {
  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${why} (+${n})`);
  };
  if (auth) {
    if (auth.spf === 'fail') add(3, 'SPF fail');
    else if (auth.spf === 'softfail') add(1.5, 'SPF softfail');
    if (auth.dkim === 'fail') add(2, 'DKIM fail');
    if (auth.dmarc === 'fail') {
      add(5, 'DMARC fail');
      if (auth.dmarcPolicy === 'reject') return { score, verdict: 'quarantine', reasons: [...reasons, 'DMARC policy reject'] };
    }
  }
  if (!msg.messageId) add(1, 'No Message-ID');
  if (!msg.sentAt) add(1, 'No Date');
  if (msg.subject.length > 12 && msg.subject === msg.subject.toUpperCase() && /[A-Z]/.test(msg.subject)) add(1, 'All-caps subject');
  if (!msg.bodyText.trim() && !msg.attachments.length) add(1, 'Empty body');
  if (/\b(viagra|lottery winner|wire transfer urgently|crypto giveaway)\b/i.test(`${msg.subject} ${msg.bodyText.slice(0, 5000)}`)) add(3, 'Spam phrases');
  const dangerous = msg.attachments.find((a) => /\.(exe|scr|bat|cmd|js|vbs|jar|ps1|msi|hta)$/i.test(a.filename));
  if (dangerous) add(4, `Executable attachment ${dangerous.filename}`);
  return { score, verdict: score >= SPAM_THRESHOLD ? 'spam' : 'ham', reasons };
}
