// Home page chrome. Must be an external module: the app serves a `script-src 'self'` CSP,
// so an inline <script> is blocked outright.

// Live UTC clock in the top rail. A dead placeholder would read as a broken element, and the
// ticking meta line is part of the studio-page idiom this layout borrows from.
const clock = document.querySelector('#clock');
if (clock) {
 const pad = n => String(n).padStart(2, '0');
 const tick = () => {
  const d = new Date();
  clock.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
 };
 tick();
 setInterval(tick, 1000);
}
