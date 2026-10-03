// Anonymous visitor statistics with GoatCounter (goatcounter.com): no cookies, no personal data, no consent banner
// needed. It records page views (country, browser, screen size, where visitors came from) and the events below,
// shown on the owner's GoatCounter dashboard. Off unless config.js sets `goatcounter` (the public build does; local
// copies don't), and GoatCounter itself never counts localhost.
//   view-<id>            a camera view button          site-<id>   a story site opened
//   lang-<vi|en>         language switch               quality-<mode>
//   layer-<name>-on|off  a map layer switched
const queue = [];
let ready = false;

export function initAnalytics(code) {
  if (!code || !/^[a-z0-9-]+$/.test(code)) return false;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  s.onload = () => { ready = true; queue.splice(0).forEach((e) => send(...e)); };
  document.head.append(s);
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
