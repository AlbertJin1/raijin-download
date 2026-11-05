import { useCallback, useEffect, useRef, useState } from 'react';

export const api = typeof window !== 'undefined' ? window.raijin : null;

const EMPTY = {
  jobs: [],
  preferences: { theme: 'dark', accent: 'amber', density: 'comfortable', showDetails: true, speedLimitKBps: 0, whenDone: 'nothing', scheduler: { enabled: false, startTime: '02:00', stopTime: '', days: [0, 1, 2, 3, 4, 5, 6] } },
  stats: { totalBytes: 0, totalFiles: 0 },
  summary: { active: 0, queued: 0, speed: 0, eta: null, progress: null },
};

/** Holds the authoritative snapshot and merges the fast 2 Hz progress ticks into it. */
export function useRaijinState(onError) {
  const [state, setState] = useState(EMPTY);
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState([]);
  const jobHistory = useRef(new Map());
  const [, force] = useState(0);

  const apply = useCallback((snapshot) => {
    if (snapshot?.jobs) setState(snapshot);
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    let alive = true;
    api.getState().then((s) => { if (alive) { apply(s); setReady(true); } }).catch((e) => onError?.(e));
    const offState = api.onState(apply);
    const offTick = api.onTick((tick) => {
      setHistory(tick.history || []);
      for (const j of tick.jobs) jobHistory.current.set(j.id, j.history);
      setState((prev) => {
        if (!tick.jobs.length) return { ...prev, summary: tick.summary };
        const patch = new Map(tick.jobs.map((j) => [j.id, j]));
        return {
          ...prev,
          summary: tick.summary,
          jobs: prev.jobs.map((job) => {
            const p = patch.get(job.id);
            if (!p) return job;
            const { history: _h, ...rest } = p;
            return { ...job, ...rest };
          }),
        };
      });
      force((n) => (n + 1) % 1e6);
    });
    return () => { alive = false; offState(); offTick(); };
  }, [apply, onError]);

  return { state, ready, apply, history, jobHistory: jobHistory.current };
}

/** Runs an API method, applies a returned snapshot and reports errors through `notify`. */
export function useAction(apply, notify) {
  return useCallback(async (method, ...args) => {
    if (!api?.[method]) return undefined;
    try {
      const result = await api[method](...args);
      if (result && result.jobs && result.preferences) apply(result);
      return result;
    } catch (error) {
      notify(error.message || 'Something went wrong.', 'error');
      return undefined;
    }
  }, [apply, notify]);
}

let audioContext = null;
export function playChime() {
  try {
    audioContext = audioContext || new AudioContext();
    const ctx = audioContext;
    const now = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.11);
      osc.stop(now + i * 0.11 + 0.5);
    });
  } catch {}
}
