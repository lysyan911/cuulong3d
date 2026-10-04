// Anonymous visitor statistics with GoatCounter (goatcounter.com): no cookies, no personal data, no consent banner
// needed. It records page views (country, browser, screen size, where visitors came from) and the events below,
// shown on the owner's GoatCounter dashboard. Off unless config.js sets `goatcounter` (the public build does; local
// copies don't), and GoatCounter itself never counts localhost.
//   view-<id>            a camera view button          site-<id>   a story site opened
//   lang-<vi|en>         language switch               quality-<mode>
//   layer-<name>-on|off  a map layer switched          mode-<study|novel>
// Per visit (each at most once):
//   visit-first | visit-return       this browser opened the map before? (a counter kept only in this browser's
//   visit-count-<2|3-5|6-10|11+>     localStorage; nothing identifying is stored or sent)
//   visit-gap-<today|1-7d|8-30d|30d+>  time since this browser's previous visit
//   device-<phone|tablet|desktop>    load-<0-5s|5-10s|10-20s|20s+>   time until the map was ready
//   fps-<under15|15-30|30-45|45+>    smoothness after ~30 s of use, with fps-<quality>-<bucket>
//   area-<id>                        a part of the province the visitor looked at closely (dwelt ~8 s)
//   explore-street                   went down to street level        time-<under30s|30s-2m|2-5m|5-15m|15m+>
//   error-js | error-webgl           something went wrong
const queue = [];
const sent = new Set();
let ready = false;

export function initAnalytics(code) {
  if (!code || !/^[a-z0-9-]+$/.test(code)) return false;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  s.onload = () => { ready = true; queue.splice(0).forEach((e) => send(...e)); };
  document.head.append(s);
  visitEvents();
  sessionEvents();
  return true;
}

function send(name, title) {
  try { window.goatcounter?.count?.({ path: name, title: title || name, event: true }); } catch { /* ignore */ }
}

/** Count an event (queued until the counter has loaded). */
export function track(name, title) {
  if (ready) send(name, title);
  else if (queue.length < 50) queue.push([name, title]);
}

/** Count an event at most once per visit. */
export function trackOnce(name, title) {
  if (sent.has(name)) return;
  sent.add(name);
  track(name, title);
}

const bucket = (v, edges, names) => names[edges.findIndex((e) => v < e) === -1 ? names.length - 1 : edges.findIndex((e) => v < e)];

// return visits: how many times this browser opened the map, and when it last did (localStorage only)
function visitEvents() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem('cuulong-visits') || 'null'); } catch { /* private mode */ }
  const now = Date.now();
  if (!v || !v.n) {
    trackOnce('visit-first');
    v = { n: 0, last: now };
  } else {
    trackOnce('visit-return');
    trackOnce(`visit-count-${bucket(v.n + 1, [3, 6, 11], ['2', '3-5', '6-10', '11+'])}`);
    const days = (now - v.last) / 864e5;
    trackOnce(`visit-gap-${bucket(days, [1, 8, 31], ['today', '1-7d', '8-30d', '30d+'])}`);
  }
  try { localStorage.setItem('cuulong-visits', JSON.stringify({ n: v.n + 1, last: now })); } catch { /* ignore */ }
}

// time on the map (sent when the page is hidden or closed), errors
function sessionEvents() {
  const t0 = performance.now();
  const leave = () => {
    const s = (performance.now() - t0) / 1000;
    trackOnce(`time-${bucket(s, [30, 120, 300, 900], ['under30s', '30s-2m', '2-5m', '5-15m', '15m+'])}`);
  };
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); });
  addEventListener('pagehide', leave);
  addEventListener('error', () => trackOnce('error-js'));
}

/** The map has loaded: device class and load time. */
export function trackReady(mobile, ms) {
  const tablet = mobile && Math.min(screen.width, screen.height) >= 600;
  trackOnce(`device-${mobile ? (tablet ? 'tablet' : 'phone') : 'desktop'}`);
  trackOnce(`load-${bucket(ms / 1000, [5, 10, 20], ['0-5s', '5-10s', '10-20s', '20s+'])}`);
}

/** Smoothness once the visitor has used the map for a while. */
export function trackFps(fps, quality) {
  const b = bucket(fps, [15, 30, 45], ['under15', '15-30', '30-45', '45+']);
  trackOnce(`fps-${b}`);
  trackOnce(`fps-${quality}-${b}`);
}
