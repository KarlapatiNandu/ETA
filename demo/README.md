# ETA — offline demo

A single self-contained page that walks through what ETA does for the three people who use it — a student, a bus driver and the Transport Department — without the backend, the phone link or a network connection. Every bus, verification code and alert is simulated in the browser.

**To run it,** double-click `index.html`. It opens in any current Chrome, Edge, Safari or Firefox and needs no install, no server and no Wi-Fi. Use a laptop screen or projector of 1280 × 800 or larger; on smaller screens the panels stack below the device.

## Layout

- **Right edge — a slim icon rail.** The top three icons choose whose screen you see: *Student*, *Driver* or *Transport office*. Below them are full screen and light/dark. Hover an icon for its name. All three look at the same simulated morning: lose Bus 14's signal and the student's phone, the driver's phone and the office console all show it.
- **Left — the talk track.** The chapters for the current view, drawn as a route line. Click one, or press its number, and the screen jumps to that part of the story; the talking point appears underneath.
- **Centre — the device.** A phone for the student and the driver, a browser window for the office. Everything on it can be clicked.
- **Right — presenter controls** (below the talk track in the office view). Trigger moments on cue instead of waiting for them. A yellow note appears here when an alert was deliberately *not* delivered to the student's phone.

## Keys

| Key | Does |
|---|---|
| `V` | Switch view: Student → Driver → Transport office |
| `1`–`6` | Jump to a chapter of the current view (the driver and office views have three each) |
| `L` | **Leave now** — Bus 14 jumps to about 10 min out; the "Leave now" alert fires a few seconds later |
| `D` | **Dead zone** — Bus 14 loses signal: amber "late updates" after a few seconds, red "signal lost" after that. Press again to restore it (it also recovers on its own) |
| `B` | **Bus breakdown** — Bus 27 goes out of service: a ticket in the office, a critical alert on the phone |
| `A` | **Announcement** — an event-day timing change from the Transport Department |
| `R` | **Reset** — back to 07:24, Bus 14 thirteen minutes out, Bus 14 starred and Bus 27 in Favourites |
| `S` | Cycle simulated time: paused, 1×, 4× (default), 10× |
| `F` | **Full screen** — presenter mode: the address bar, tabs and the rest of the browser disappear, leaving the talk track, the device and the controls. The rail dims until you point at it. `F` or `Esc` leaves it |
| `T` | Light / dark theme (the page opens in light, which reads best on a projector) |
| `H` | Hide everything except the device (combine with `F` for the phone alone on a blank screen) |
| `Esc` | Close a notification or the bus sheet |

## The student: a six-minute run-through

1. **Claim** (`1`): tap *Claim your account*, then *Send code*. The roll number types itself, an SMS drops in, and tapping it (or the *From Messages* chip) fills the code. Tap *Create account*.
2. **Search** (`2`): tap *Find my bus*, then try the misspelling chips — `dilsuknagar`, `kothi`, `lb ngr`. The heart next to a bus saves it; *Track* saves it and opens it on the map.
3. **Favourites** (`3`): the starred bus sits at the top as "Your bus". Tap another bus's star to make it yours instead, or the × to remove one. The starred bus is the marigold marker on the map, and one tap from the home screen.
4. **Track** (`4`): point out the split-flap ETA *range* and its confidence dot, the "Leave in" line that explains itself, and the route timeline. Press `L` for the alert.
5. **Dead zone** (`5` or `D`): the marker turns dashed amber, then hollow red; the arrival time disappears instead of guessing. Press `D` to restore it — the buffered positions are replayed.
6. **Alerts** (`6`): press `B` and `A`; show the tiers, the ticket status and the acknowledgement. Tap *I'm on the bus* on the home screen to show that non-critical alerts are recorded but not pushed.

**Favourites decide who is alerted.** An alert about a bus reaches this phone only if that bus is in Favourites; an alert sent to one route reaches it only if a favourite is on that route. To show it: remove Bus 27 in Favourites, press `B`, and the phone stays quiet while the presenter panel says why. Notices sent to all students always arrive.

## The driver (`V`, then `1`–`3`)

1. **Pair once, then one button**: the idle screen — today's route and START TRIP, in English, Telugu or Hindi.
2. **On trip**: pings sent, last sent, and nothing to touch. END TRIP asks for a second tap.
3. **No network** (or `D`): the phone keeps recording and counts what is waiting to send; press `D` again and the count returns to zero.

## The Transport office (`V` twice, then `1`–`3`)

1. **Live fleet**: every bus with its signal, last ping and position along its route. Press `D` and Bus 14's row turns amber, then red.
2. **Tickets**: chapter `2` (or `B`) opens a breakdown ticket for Bus 27 with the students notified and acknowledging. *Mark back in service* closes it and tells the students.
3. **Announcements**: choose how loud and who it is for, then *Send announcement now*; switch to the Student view to see it land. The recent list shows how many have read each one.

## What is real and what is not

The wording, the ETA range and "leave in" arithmetic, the presence states and the alert tiers follow the real student app (`apps/web`). The driver screen follows `apps/driver` and uses its strings; the Telugu and Hindi are that app's first draft and still need a native speaker's review. The office console follows the TD Console in `apps/web`, reduced to three of its ten pages and laid out with a side menu.

Made for this demo, not taken from the product: the colour palette and typefaces, the Favourites page and starred bus, and the rule that favourites decide who is alerted. The map is a schematic, and the buses, timings, student counts, read receipts and acknowledgements are invented. The driver's START and END buttons change the driver's screen only — Bus 14 keeps running in the simulation.

The three figures on the left — 4.0 s p95, 1,000 students, 5 of 5 drills — are real measurements from the full local stack (see the project README). Leave-now alerts are built but stay switched off for real students until ETA accuracy has been measured on real buses; the talk track says so.
