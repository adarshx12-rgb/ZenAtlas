// Shared tuning knobs for the buddha-hand scroll reveal (public/hand.js).
// One transparent clip — a stone hand opening from a mudra pinch into an offered palm —
// is scroll-scrubbed while the search bar rides down to rest on the palm.
//
// Everything under `frame`, `palm` and `cradleWidth` is MEASURED off the keyed clip's
// final frame, not chosen: the alpha silhouette was sampled at 682px wide and the top
// profile walked to find the thumb tip (0.692, 0.016), the palm hollow (0.739, 0.292)
// and the finger tips (0.909, 0.169). Re-measure if the clip is ever re-cut.
//
// The clip is built from the generator's own export by reversing it (it was generated
// open -> closed) and keying the black, in one ffmpeg pass. Its first 5 frames are
// dropped: frame 0 is an H.264 I-frame carrying 90 speck artefacts totalling ~1000px,
// which the key turns into visible debris floating around the hand. From frame 5 on it
// is at the clip's noise floor of 2-5 single pixels. Since the clip is reversed, that
// frame would otherwise be the LAST one — the one the bar lands on.
export const CONFIG = {
 scrollVh: 220, // pinned scroll distance; one clip needs less than the old three-clip intro
 clip: '/videos/zenatlas/buddha-hand.webm',
 // Native size of the keyed clip (16:9). Kept at the generator's own resolution on purpose:
 // `coverScale` blows the clip up past the viewport width, so anything smaller is being
 // upscaled on screen, and the hand's pore and crease detail is the first thing to go.
 frame: { w: 1364, h: 768 },

 // Where the bar comes to rest, as a fraction of the frame. `x` is the centre of the
 // cradle (midpoint of thumb tip and finger tips), not the hollow's own x — the bar wants
 // to sit centred between the two, not over the lowest point. `y` is the hollow's depth,
 // and the bar's BOTTOM edge lands there so it rests on the palm rather than sinking in.
 palm: { x: 0.801, y: 0.292 },

 // How far below that measured dip the bar actually settles, as a fraction of the frame.
 // The dip is the TOP of the palm silhouette — the cup's far rim — so landing exactly on
 // it leaves the bar perched on the back edge with the hollow visibly empty in front. A
 // little sink puts it in the cup. This one is chosen by eye, not measured.
 sink: 0.072,

 // Thumb tip -> finger tips on the final frame. The landed bar is deliberately wider than
 // this and overhangs, the way a tray sits on a hand; keeping the width pinned to the
 // cradle means it stays in proportion at any viewport instead of a magic pixel number.
 cradleWidth: 0.217,
 barToCradle: 1.5,
 landedBarMin: 320, // px — below this the field stops being usable, so stop shrinking

 // Clip width as a multiple of the viewport. Tuned so the cradle lands at ~0.21 of the
 // viewport width: the uncropped 16:9 source carries the hand larger in frame than the
 // 2.33:1 version did (cradle 0.217 vs 0.168), so this is below 1 to hold the hand at the
 // same on-screen size rather than letting the reframe enlarge it.
 coverScale: 0.97,
 landing: { y: 0.62 }, // bar's resting bottom edge, as a fraction of viewport height
 heroLift: 40, // px the headline travels up as it clears out

 // Below this width the hand is dropped entirely: at phone widths the cradle is ~80px and
 // a search field cannot sit on it convincingly. Those viewports get the plain page, and
 // so does anyone asking for reduced motion — see the header of hand.js for why.
 staticBelow: 760,

 stages: {
  heroOut: [0, 0.22],
  rise: [0.04, 0.9], // the hand travels up from below the fold; without this it is simply
                     // already there on load, and nothing "appears" as you scroll
  barTravel: [0.18, 0.9],
  labelOut: [0.3, 0.5], // the field's own label, which becomes unreadable over the stone
  clip: [0, 0.9], // the hand finishes opening exactly as the bar lands, not after it
 },
};
