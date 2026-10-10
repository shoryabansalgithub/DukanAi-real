import { readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Every alert has a runbook and every runbook an alert (roadmap 9.22). An
 * alert added to `deploy/prometheus/alerts.yml` without a page in
 * `docs/RUNBOOKS.md` (or a page left behind by a removed alert) fails here,
 * not at three in the morning; so does a `runbook_url` that does not lead
 * to its page, or a page missing one of the parts the on-call relies on.
 */
const ROOT = resolve(__dirname, '../../../../..');
const RUNBOOK_BASE = 'https://github.com/shoryabansalgithub/DukanAi-real/blob/main/docs/RUNBOOKS.md';
const PARTS = ['**First checks', '**Fix', '**Verify.**', '**Tell the shops.**', '**Walked:**'];

interface Rule {
  name: string;
  severity: string;
  runbookUrl: string | undefined;
}

function rules(): Rule[] {
  const source = readFileSync(join(ROOT, 'deploy/prometheus/alerts.yml'), 'utf8');
  const blocks = source.split(/\n(?=[ \t]+- alert: )/).filter((block) => /^[ \t]+- alert: /.test(block));
  return blocks.map((block) => ({
    name: /- alert: (\S+)/.exec(block)![1],
    severity: /severity: (\S+)/.exec(block)?.[1] ?? '',
    runbookUrl: /runbook_url: "([^"]+)"/.exec(block)?.[1],
  }));
}

function runbookPages(): Map<string, string> {
  const doc = readFileSync(join(ROOT, 'docs/RUNBOOKS.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 5. Runbooks'), doc.indexOf('## 6. '));
  const pages = new Map<string, string>();
  for (const part of section.split(/\n(?=### )/).slice(1)) {
    const heading = /^### (\S+)/.exec(part)![1];
    pages.set(heading, part);
  }
  return pages;
}

describe('alert runbooks (roadmap 9.22)', () => {
  const alerts = rules();
  const pages = runbookPages();

  it('finds the alert rules and the runbook pages', () => {
    expect(alerts.length).toBeGreaterThanOrEqual(21);
    expect(pages.size).toBeGreaterThanOrEqual(21);
  });

  it('every alert has exactly one runbook page and every page names an alert', () => {
    expect([...pages.keys()].sort()).toEqual(alerts.map((a) => a.name).sort());
  });

  it.each(rules().map((a) => [a.name, a]))('%s links its page and the page has every part', (_name, alert) => {
    const { name, severity, runbookUrl } = alert as Rule;
    expect(runbookUrl).toBe(`${RUNBOOK_BASE}#${name.toLowerCase()}`);
    const page = pages.get(name) ?? '';
    // The page opens with the alert's own severity.
    expect(page).toMatch(new RegExp(`^### ${name}\\n\\n\\*\\*${severity.charAt(0).toUpperCase()}${severity.slice(1)}\\b`));
    for (const part of PARTS) expect({ name, part, present: page.includes(part) }).toEqual({ name, part, present: true });
  });

  it('every page records its walk and section 7 has its row (the gate of roadmap 9.22: a new alert is walked on the drill stack before it ships)', () => {
    const doc = readFileSync(join(ROOT, 'docs/RUNBOOKS.md'), 'utf8');
    const record = doc.slice(doc.indexOf('## 7. '));
    for (const alert of alerts) {
      const page = pages.get(alert.name) ?? '';
      expect({ alert: alert.name, walked: /\*\*Walked:\*\* \d{4}-\d{2}-\d{2}\b/.test(page) }).toEqual({ alert: alert.name, walked: true });
      expect({ alert: alert.name, recorded: record.includes(`| \`${alert.name}\` |`) }).toEqual({ alert: alert.name, recorded: true });
    }
  });

  it('the one-line summary in docs/OBSERVABILITY.md names every alert', () => {
    const observability = readFileSync(join(ROOT, 'docs/OBSERVABILITY.md'), 'utf8');
    for (const alert of alerts) expect({ alert: alert.name, listed: observability.includes(`| \`${alert.name}\` |`) }).toEqual({ alert: alert.name, listed: true });
  });
});
