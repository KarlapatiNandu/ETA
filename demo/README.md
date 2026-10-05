# Bus Mitra — offline demo

A single self-contained page that walks through what Bus Mitra does for a student, without the backend, the phone link or a network connection. Every bus, verification code and alert is simulated in the browser.

**To run it,** double-click `index.html`. It opens in any current Chrome, Edge, Safari or Firefox and needs no install, no server and no Wi-Fi. Use a laptop screen or projector of 1280 × 800 or larger; on smaller screens the panels stack below the phone.

## Layout

- **Left — the talk track.** Five chapters drawn as a metro line. Click one, or press `1`–`5`, and the phone jumps to that part of the story; the talking point for it appears underneath.
- **Centre — the phone.** Everything on it can be tapped: buttons, tabs, search, the buses on the map.
- **Right — presenter controls.** Trigger moments on cue instead of waiting for them.

## Keys

| Key | Does |
|---|---|
| `1`–`5` | Jump to a chapter |
| `L` | **Leave now** — Bus 14 jumps to about 10 min out; the "Leave now" alert fires a few seconds later |
| `D` | **Dead zone** — Bus 14 loses signal: amber "late updates" after a few seconds, red "signal lost" after that. Press again to restore it (it also recovers on its own) |
| `B` | **Bus breakdown** — a critical alert with a service ticket and a "Got it" acknowledgement |
| `A` | **Announcement** — an event-day timing change from the Transport Department |
| `R` | **Reset** — back to 07:24, Bus 14 thirteen minutes out |
| `S` | Cycle simulated time: paused, 1×, 4× (default), 10× |
| `T` | Light / dark theme (light can read better on a washed-out projector) |
| `H` | Hide both side panels for a clean phone-only view |
| `Esc` | Close a notification or the bus sheet |

## A five-minute run-through

1. **Claim** (`1`): tap *Claim your account*, then *Send code*. The roll number types itself, an SMS drops in, and tapping it (or the *From Messages* chip) fills the code. Tap *Create account*.
2. **Search** (`2`): tap *Find my bus*, then try the misspelling chips — `dilsuknagar`, `kothi`, `lb ngr`. Tap *Follow* next to Bus 14.
3. **Follow** (`3`): point out the split-flap ETA *range* and its confidence dot, the "Leave in" line that explains itself, and the route timeline. Press `L` for the alert.
4. **Dead zone** (`4` or `D`): the marker turns dashed amber, then hollow red; the arrival time disappears instead of guessing. Press `D` to restore it — the buffered positions are replayed.
5. **Alerts** (`5`): press `B` and `A`; show the tiers, the ticket status and the acknowledgement. Tap *I'm on the bus* on the home screen to show that non-critical alerts are recorded but not pushed.

## What is real and what is not

The look, the wording, the ETA range and "leave in" arithmetic, the presence states and the alert tiers follow the real app (`apps/web`). The map is a schematic, and the buses, timings and student counts are invented for the demo. The three figures on the left — 4.0 s p95, 1,000 students, 5 of 5 drills — are real measurements from the full local stack (see the project README). Leave-now alerts are built but stay switched off for real students until ETA accuracy has been measured on real buses; the talk track says so.
