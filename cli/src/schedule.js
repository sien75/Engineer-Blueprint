const MAX_TIMEOUT_MS = 2_147_483_647;

const MONTH_ALIASES = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_ALIASES = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const DURATION_RE = /^([1-9]\d*)(s|m|h)$/i;
const DAILY_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseCronTokenValue(raw, { min, max, aliases, mapValue }) {
  const upper = raw.toUpperCase();
  let num;
  if (aliases && Object.hasOwn(aliases, upper)) {
    num = aliases[upper];
  } else if (/^\d+$/.test(raw)) {
    num = Number(raw);
  } else {
    throw new Error(`Invalid cron token "${raw}".`);
  }

  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`Cron value "${raw}" out of range [${min}..${max}].`);
  }
  return mapValue ? mapValue(num) : num;
}

function parseCronField(fieldExpr, opts) {
  const { min, max, name, mapValue } = opts;
  const trimmed = fieldExpr.trim();
  if (!trimmed) {
    throw new Error(`Empty cron ${name} field.`);
  }

  const wildcard = trimmed === "*";
  const values = new Set();

  for (const part of trimmed.split(",")) {
    if (!part) {
      throw new Error(`Invalid empty segment in cron ${name} field "${fieldExpr}".`);
    }

    const slashParts = part.split("/");
    if (slashParts.length > 2) {
      throw new Error(`Invalid step syntax in cron ${name} field "${part}".`);
    }

    const rangeExpr = slashParts[0];
    let step = 1;
    if (slashParts.length === 2) {
      if (!/^[1-9]\d*$/.test(slashParts[1])) {
        throw new Error(`Invalid step "${slashParts[1]}" in cron ${name} field.`);
      }
      step = Number(slashParts[1]);
    }

    let start;
    let end;

    if (rangeExpr === "*") {
      start = min;
      end = max;
    } else if (rangeExpr.includes("-")) {
      const bounds = rangeExpr.split("-");
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
        throw new Error(`Invalid range "${rangeExpr}" in cron ${name} field.`);
      }
      start = parseCronTokenValue(bounds[0], { ...opts, mapValue: null });
      end = parseCronTokenValue(bounds[1], { ...opts, mapValue: null });
      if (start > end) {
        throw new Error(`Range start > end ("${rangeExpr}") in cron ${name} field.`);
      }
    } else {
      start = parseCronTokenValue(rangeExpr, { ...opts, mapValue: null });
      end = slashParts.length === 2 ? max : start;
    }

    for (let v = start; v <= end; v += step) {
      values.add(mapValue ? mapValue(v) : v);
    }
  }

  if (values.size === 0) {
    throw new Error(`Cron ${name} field "${fieldExpr}" matched no values.`);
  }

  return { wildcard, values };
}

function getNextCronDate(spec, fromDate = new Date()) {
  const cur = new Date(fromDate.getTime());
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);

  const maxYear = fromDate.getFullYear() + 5;

  while (cur.getFullYear() <= maxYear) {
    if (!spec.month.values.has(cur.getMonth() + 1)) {
      cur.setMonth(cur.getMonth() + 1, 1);
      cur.setHours(0, 0, 0, 0);
      continue;
    }

    const domMatch = spec.dom.values.has(cur.getDate());
    const dowMatch = spec.dow.values.has(cur.getDay());
    const dayOk =
      !spec.dom.wildcard && !spec.dow.wildcard ? domMatch || dowMatch : domMatch && dowMatch;

    if (!dayOk) {
      cur.setDate(cur.getDate() + 1);
      cur.setHours(0, 0, 0, 0);
      continue;
    }

    if (!spec.hour.values.has(cur.getHours())) {
      cur.setHours(cur.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!spec.minute.values.has(cur.getMinutes())) {
      cur.setMinutes(cur.getMinutes() + 1, 0, 0);
      continue;
    }

    return cur;
  }

  throw new Error(`Cron expression "${spec.expr}" has no upcoming occurrence within 5 years.`);
}

/**
 * Parse and validate an `every="..."` schedule expression:
 * - Duration intervals: `<n>s`, `<n>m`, `<n>h`
 * - Daily clock time: `HH:MM` (24-hour)
 * - 5-field cron: `minute hour dom month dow`
 * @param {string} expr
 */
export function parseSchedule(expr) {
  if (typeof expr !== "string" || expr.trim().length === 0) {
    throw new Error("Schedule expression cannot be empty.");
  }

  const trimmed = expr.trim();

  const durMatch = DURATION_RE.exec(trimmed);
  if (durMatch) {
    const amount = Number(durMatch[1]);
    const unit = durMatch[2].toLowerCase();
    const unitMs = unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
    const intervalMs = amount * unitMs;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(`Duration interval "${expr}" is out of bounds.`);
    }
    return { kind: "interval", expr: trimmed, intervalMs };
  }

  const dailyMatch = DAILY_RE.exec(trimmed);
  if (dailyMatch) {
    const hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2]);
    return { kind: "daily", expr: trimmed, hour, minute };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid schedule "${expr}". Expected <n>s|<n>m|<n>h, HH:MM, or 5-field cron (minute hour dom month dow).`
    );
  }

  const spec = {
    kind: "cron",
    expr: trimmed,
    minute: parseCronField(parts[0], { min: 0, max: 59, name: "minute" }),
    hour: parseCronField(parts[1], { min: 0, max: 23, name: "hour" }),
    dom: parseCronField(parts[2], { min: 1, max: 31, name: "day-of-month" }),
    month: parseCronField(parts[3], {
      min: 1,
      max: 12,
      name: "month",
      aliases: MONTH_ALIASES,
    }),
    dow: parseCronField(parts[4], {
      min: 0,
      max: 7,
      name: "day-of-week",
      aliases: DOW_ALIASES,
      mapValue: (v) => (v === 7 ? 0 : v),
    }),
  };

  // Validate that the cron combination is reachable on a real calendar
  getNextCronDate(spec, new Date());
  return spec;
}

/**
 * Compute the next trigger `Date` strictly after `fromDate` for a schedule expression or parsed spec.
 * @param {string | ReturnType<typeof parseSchedule>} exprOrSpec
 * @param {Date} [fromDate]
 * @returns {Date}
 */
export function getNextScheduleTime(exprOrSpec, fromDate = new Date()) {
  const spec = typeof exprOrSpec === "string" ? parseSchedule(exprOrSpec) : exprOrSpec;
  if (spec.kind === "interval") {
    return new Date(fromDate.getTime() + spec.intervalMs);
  }
  if (spec.kind === "daily") {
    const next = new Date(
      fromDate.getFullYear(),
      fromDate.getMonth(),
      fromDate.getDate(),
      spec.hour,
      spec.minute,
      0,
      0
    );
    if (next.getTime() <= fromDate.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
  return getNextCronDate(spec, fromDate);
}

/**
 * Start a recurring schedule for `expr`, invoking `fn` on each tick without overlap.
 * Returns a `stop()` handle (callable both as `handle.stop()` and `handle()`).
 * @param {string} expr
 * @param {() => Promise<void> | void} fn
 * @param {{ onError?: (err: unknown) => void }} [options]
 */
export function startSchedule(expr, fn, { onError } = {}) {
  const spec = parseSchedule(expr);
  let stopped = false;
  let running = false;
  let intervalId = null;
  let timeoutId = null;

  const invoke = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      if (onError) {
        onError(err);
      } else {
        console.error(`[bp:schedule "${spec.expr}"]`, err);
      }
    } finally {
      running = false;
    }
  };

  if (spec.kind === "interval" && spec.intervalMs <= MAX_TIMEOUT_MS) {
    intervalId = setInterval(() => {
      void invoke();
    }, spec.intervalMs);
  } else {
    const scheduleAt = (targetTimeMs) => {
      if (stopped) return;
      const remaining = targetTimeMs - Date.now();
      if (remaining <= 0) {
        void invoke().finally(() => {
          if (!stopped) {
            scheduleNext();
          }
        });
        return;
      }
      const delay = Math.min(remaining, MAX_TIMEOUT_MS);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (stopped) return;
        if (Date.now() < targetTimeMs - 1) {
          scheduleAt(targetTimeMs);
        } else {
          void invoke().finally(() => {
            if (!stopped) {
              scheduleNext();
            }
          });
        }
      }, delay);
    };

    const scheduleNext = () => {
      if (stopped) return;
      const nextDate = getNextScheduleTime(spec, new Date());
      scheduleAt(nextDate.getTime());
    };

    scheduleNext();
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  stop.stop = stop;
  return stop;
}
