/**
 * Minimal robots.txt awareness.
 *
 * ProxyPulse only ever asks a service adapter to fetch paths it is allowed to fetch. The service
 * checker therefore consults this parser before probing anything and refuses paths disallowed for
 * our user agent. Implemented as pure functions so it can be unit tested without a network.
 */

export interface RobotsRules {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelaySeconds: number | null;
}

export interface RobotsDecision {
  allowed: boolean;
  reason: 'no_robots' | 'disallow' | 'allow' | 'no_rules' | 'fetch_failed';
  crawlDelaySeconds: number | null;
}

export const EMPTY_ROBOTS: RobotsRules = {
  userAgent: '*',
  allow: [],
  disallow: [],
  crawlDelaySeconds: null,
};

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
  sawRule: boolean;
}

/** Parses robots.txt content, returning the rule group matching `userAgent` (falling back to `*`). */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const normalizedAgent = userAgent.toLowerCase();
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // A user-agent line after rules starts a new group.
      if (!current || current.sawRule) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null, sawRule: false };
        groups.push(current);
      }
      if (value.length > 0) current.agents.push(value.toLowerCase());
      continue;
    }

    if (!value && field !== 'disallow') continue;
    if (!current) {
      current = { agents: ['*'], allow: [], disallow: [], crawlDelay: null, sawRule: false };
      groups.push(current);
    }
    current.sawRule = true;
    if (field === 'disallow') current.disallow.push(value);
    else if (field === 'allow') current.allow.push(value);
    else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) current.crawlDelay = seconds;
    }
  }

  const wildcard = groups.find((group) => group.agents.includes('*')) ?? null;
  const specific =
    groups.find((group) =>
      group.agents.some((agent) => agent !== '*' && normalizedAgent.includes(agent)),
    ) ?? null;
  const chosen = specific ?? wildcard;
  if (!chosen) return { ...EMPTY_ROBOTS, userAgent: normalizedAgent };
  return {
    userAgent: specific ? chosen.agents[0]! : '*',
    allow: chosen.allow,
    disallow: chosen.disallow,
    crawlDelaySeconds: chosen.crawlDelay,
  };
}

/** Robots pattern matching with `*` wildcards and `$` end anchors (Google style, subset). */
export function pathMatchesPattern(path: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(anchored ? `^${escaped}$` : `^${escaped}`);
  return re.test(path);
}

export function decidePath(
  path: string,
  rules: RobotsRules,
): { allowed: boolean; reason: 'allow' | 'disallow' | 'no_rules' } {
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const pattern of rules.allow) {
    if (pathMatchesPattern(path, pattern)) bestAllow = Math.max(bestAllow, pattern.length);
  }
  for (const pattern of rules.disallow) {
    if (pathMatchesPattern(path, pattern)) bestDisallow = Math.max(bestDisallow, pattern.length);
  }
  if (bestAllow === -1 && bestDisallow === -1) return { allowed: true, reason: 'no_rules' };
  if (bestAllow > bestDisallow) return { allowed: true, reason: 'allow' };
  return { allowed: false, reason: 'disallow' };
}

/**
 * Combines a fetch result with our policy: unknown robots.txt (404/410) means "everything
 * allowed"; a robots.txt we cannot read at all means "refuse to probe" (fail closed).
 */
export function evaluateRobots(
  path: string,
  userAgent: string,
  robots: { status: number; text: string } | { status: 0; text: ''; error: true },
): RobotsDecision {
  if ('error' in robots && robots.error) {
    return { allowed: false, reason: 'fetch_failed', crawlDelaySeconds: null };
  }
  if (robots.status === 404 || robots.status === 410 || robots.status >= 500) {
    return { allowed: true, reason: 'no_robots', crawlDelaySeconds: null };
  }
  if (robots.status < 200 || robots.status >= 400) {
    return { allowed: false, reason: 'fetch_failed', crawlDelaySeconds: null };
  }
  const rules = parseRobots(robots.text, userAgent);
  const decision = decidePath(path, rules);
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    crawlDelaySeconds: rules.crawlDelaySeconds,
  };
}
