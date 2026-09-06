// Estimates how many DISTINCT PEOPLE (not tasks) are needed to cover a set
// of tasks over time. One qualified person can perform several different
// tasks — even ones needing different qualifications — back-to-back within
// the same interval, as long as the tasks don't overlap and the person
// holds every qualification each of them needs. Counting raw task overlap
// per interval (the old approach) overstates demand whenever that happens.
//
// The estimate works by greedily packing tasks onto the smallest number of
// "channels" (virtual staff slots). Each channel is backed by a REAL
// qualification profile drawn from the roster, so a channel never assumes
// a hypothetical person whose exact skill combination doesn't exist in
// practice — only that at least one real employee could plausibly do it.
// This is a greedy heuristic (first-fit, chronological order), not a
// guaranteed-minimum solve — good enough for a planning estimate, same
// spirit as the optimizer's own pass-based heuristic.
import { hasAllQuals } from '../optimizer';

export const GRANULARITY_OPTIONS = [
  { label: '5 мин', value: 5 },
  { label: '15 мин', value: 15 },
  { label: '30 мин', value: 30 },
  { label: '60 мин', value: 60 },
];

// Distinct real qualification-profiles present in the roster, broadest
// (most quals) first. A new channel prefers the most versatile real profile
// that still fits the task it's opened for — that's what makes a LATER,
// different-qualification task able to land on the same channel instead of
// opening a second one, which is the whole point of counting people
// instead of tasks. (The narrowest-first alternative was tried and
// systematically undercounted this exact "one broadly-qualified person
// covers two different-skill tasks" case, since it locks each channel into
// a single-skill profile that can never pick up the second task.)
function distinctProfiles(roster) {
  const seen = new Map();
  for (const person of roster) {
    const quals = [...new Set(person.quals || [])];
    const key = [...quals].sort().join('|');
    if (!seen.has(key)) seen.set(key, quals);
  }
  return [...seen.values()].sort((a, b) => b.length - a.length);
}

// Packs `tasks` onto the minimum number of channels such that no channel's
// own tasks overlap in time, and every task assigned to a channel is
// covered by that channel's fixed qualification profile. Falls back to an
// exact-fit hypothetical profile per channel when no roster is available
// yet (e.g. aux data not loaded) so the estimate still degrades gracefully.
export function packIntoChannels(tasks, roster = []) {
  const profiles = roster.length > 0 ? distinctProfiles(roster) : null;
  const sorted = [...tasks].sort((a, b) => a.start - b.start);
  const channels = [];

  for (const t of sorted) {
    let channel = channels.find(c => c.lastEnd <= t.start && hasAllQuals(c.quals, t));
    if (!channel) {
      let quals = t.reqTypes && t.reqTypes.length > 0 ? t.reqTypes : (t.reqType ? [t.reqType] : []);
      if (profiles) {
        const fit = profiles.find(p => hasAllQuals(p, t));
        if (fit) quals = fit;
      }
      channel = { quals, lastEnd: -Infinity, tasks: [] };
      channels.push(channel);
    }
    channel.tasks.push(t);
    channel.lastEnd = t.end;
  }
  return channels;
}

// Buckets channel activity into fixed-size time slots. A channel counts as
// active in a bucket only when it actually has a task overlapping it — the
// gaps between a channel's own tasks are real idle time, not demand.
export function bucketizeChannels(channels, windowStart, windowDays, granularityMin) {
  const base = new Date(windowStart + 'T00:00:00');
  const bucketMs = granularityMin * 60000;
  const bucketCount = Math.ceil((windowDays * 24 * 3600000) / bucketMs);
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const start = new Date(base.getTime() + i * bucketMs);
    return { start, end: new Date(start.getTime() + bucketMs), count: 0, byQual: {} };
  });

  for (const channel of channels) {
    for (const t of channel.tasks) {
      const from = Math.max(0, Math.floor((t.start - base) / bucketMs));
      for (let i = from; i < buckets.length && buckets[i].start < t.end; i++) {
        const b = buckets[i];
        if (b.end <= t.start) continue;
        if (!b._seen) b._seen = new Set();
        if (b._seen.has(channel)) continue; // count each channel once per bucket
        b._seen.add(channel);
        b.count++;
        const qual = t.reqType || '(без квалификации)';
        b.byQual[qual] = (b.byQual[qual] || 0) + 1;
      }
    }
  }
  for (const b of buckets) delete b._seen;
  return buckets;
}
