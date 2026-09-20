## **Bus Mitra** 

Live bus tracking for the CBIT campus fleet. Live map, per-stop ETAs, arrival alerts. 

Department of Information Technology, Chaitanya Bharathi Institute of Technology 



### **Problem** 

Students have no way to know where a bus is, or whether it is running at all. 



<!-- Start of picture text -->
12 minutes of guessing<br>r ) r a= ao<br>U\|<br>\ee / o=>0<br>a See<br>7:40 — no information 7:52'—<br>student reaches stop bus already departed.<br><!-- End of picture text -->

###### **No live position** 

Nobody outside the driver knows where a bus is right now. 

###### **No per-stop ETA** 

Printed timetables don't survive traffic, breakdowns or route changes. 

###### **No data trail** 

Coordination runs on WhatsApp and phone calls. Nothing is recorded. 

Bus Mitra 

2 

### **Alternatives** 

Bus tracking is solved for regulators and for city transit. Not for a single campus. 

|**Approach**|**Example**|**Real-time granularity**|**Gap for a college campus**|
|---|---|---|---|
|**Govt. AIS-140 VLTD +**<br>**state ITS backend**|State RTC / school-transport<br>tracking mandates|Vehicle-level, feeds<br>government servers|Built for regulatory compliance, not student-facing<br>search, favourites or alerts. ₹4,000–25,000 per<br>device.|
|**Commercial fleet-tracking**<br>**SaaS**|LocoNav, TrackoBit,<br>Sahaj GPS|Fleet-manager dashboard|No student app and no per-stop ETA.<br>₹500–900 per vehicle per month, recurring.|
|**City transit apps**|Chalo, state RTC apps|Very good UX,<br>the closest parallel|Built on city-wide public ridership economics, which<br>don't exist for a private single-campus fleet.|
|**Status quo at most**<br>**colleges**|WhatsApp groups, phone<br>calls,<br>printed timetables|None|Zero live data, zero accountability, and it breaks<br>completely on holidays and route changes.|



Bus Mitra 

3 

### **App** 

Four interactions cover almost everything a student needs. 

#### **Live map** 

Every running bus on the route, updating continuously. 

#### **Search a stop** 

Type a stop, see every bus serving it with an ETA. 

#### **Arrival alert** 

A push notification a set number of minutes out. 

#### **Favourites** 

Pin the bus you take daily and skip the search. 



<!-- Start of picture text -->
Qu 4min ><br>& 22 9min- > a Busin 5 14minutes. arriving<br>&@ 27 14min ><br>fe) Bus 14 - 4min<br><!-- End of picture text -->

###### **A D M I N C O N S O L E** 

Fleet status, which buses are active today, and holiday or route overrides that the student app picks up immediately. 

Bus Mitra 

4 

### **Architecture** 

Four layers, each independently replaceable. 



<!-- Start of picture text -->
t<br>L<br>L<br><!-- End of picture text -->

_Decoupling ingestion from delivery: GPS collection keeps running at full rate even when every student opens the app at 4 p.m._ 

Bus Mitra 

5 

### **Latency** 

Target budget for a GPS ping to reach the student's screen. 



<!-- Start of picture text -->
9 tracker}GPS (a) uplinkM2M SIM >] SS@D serviceingestion | brokerPub/Sub | engive:ETA limes () pushWebSocket 4 Studentphone<br>~1s ~2s 1 ~1s ~2s ~1s ~1s<br>v<br>PostgreSQLPostGIS, +<br>~ 8 seconds (end-to-end)<br><!-- End of picture text -->

**15 s   Ping interval ~8 s   Pipeline latency ~23 s   Worst-case staleness** How often the tracker reports a new position. Uplink, ingestion, ETA recompute and push. Ping interval plus pipeline. 

Bus Mitra 

6 

### **ETA** 

Raw GPS is noisy. Distance to the next stop is measured along the route, never straight-line. 

# **1** @ 

##### **1 Snap** 

Each ping is matched to the nearest point on the known route, not trusted as-is. 

**2** Y ) 

**2 Measure** 

Remaining distance is computed along the route geometry via OSRM. 

##### **Estimate** 

**3** 

Distance plus recent average speed for that segment gives the per-stop ETA. 



<!-- Start of picture text -->
° —<br>Stop 5<br>raw GPS pings<br>km<br>ee Stop“9<br>'e to Stop 5<br>e Stople;anto Stopom 4<br>Stop 2 to Stop 3<br>e<br>/ °<br>distance along route, not straight-line<br><!-- End of picture text -->

Bus Mitra 

7 

### **Failures** 

Every failure mode has a defined behaviour. The app never fabricates a live position. 

|**Failure mode**|**System response**|**What the student sees**|
|---|---|---|
|**Bus passes through a tunnel**<br>**or cellular dead zone**|Tracker buffers pings locally and<br>flushes the backlog on reconnect|"Last seen 2 min ago", an honest<br>stale marker, not a frozen live dot|
|**Tracker loses power or**<br>**drops off the network**|M2M SIM monitoring surfaces the<br>device centrally for transport staff|The bus leaves the live map rather<br>than sitting at a stale position|
|**Traffic spike when every**|Pub/Sub decouples ingestion from|Map keeps updating at normal rate;<br>i  f|
|**student opens the app at once**|delivery; stateless API scales out|GPS collection is unaffected|
|**Backend node or database**<br>**failure**|Monitoring plus daily backups;<br>stateless services restart clean|Brief reconnect, then live again,<br>with no loss of historical route data|



_Showing a stale timestamp instead of a confident wrong position is a product decision._ 

Bus Mitra 

8 

### **Cost** 

25-bus fleet. Commodity hardware, India-hosted infrastructure, open-source mapping. 

|**Item**|**Unit cost**|**Qty**|**Year 1 total**|
|---|---|---|---|
|GPS + GSM 4G tracker (bulk, non-AIS-140)|₹1,800|25|₹45,000|
|Installation & wiring harness|₹250|25|₹6,250|
|M2M / IoT SIM, bulk enterprise plan|₹75 / month|25 SIMs × 12 mo|₹22,500|
|Cloud VPS (2 vCPU / 4 GB, India-hosted)|₹1,200 / month|12 mo|₹14,400|
|Domain name|₹800 / year|1|₹800|
|Google Play developer account (one-time)|₹2,100|1|₹2,100|
|Map tiles, push notifications, SSL (OSM, Firebase free<br>tier, Let's Encrypt)|₹0|n/a|₹0|
|**Total (Year 1, 25 buses)**|||**≈ ₹91,050**|
|**Recurring from Year 2**|||**≈ ₹37,700/yr**|



**₹3,640** 

per bus, per year 

**₹18** 

per student, per year 

Bus Mitra 

9 

### **Rollout** 

Each phase has to prove something before the next one is funded. 



<!-- Start of picture text -->
01<br>P I L O T<br>3   buses, web app<br>• Ping reliability on live routes<br>• Dead-zone buffering through<br>underpasses<br>• ETA accuracy against actual arrival<br><!-- End of picture text -->



<!-- Start of picture text -->
02<br><!-- End of picture text -->



<!-- Start of picture text -->
03<br><!-- End of picture text -->



<!-- Start of picture text -->
C A M P U S - W I D E<br>All   routes<br><!-- End of picture text -->

- **F L E E T C A M P U S - W I D E 25** buses, mobile app **All** routes • Mobile app release to students • Every bus in the fleet on the map • Load testing at peak usage • Open to the full student body • Admin workflows and holiday • Handover to campus IT scheduling 

_No fleet-wide spend until the pilot proves ETA accuracy on real routes._ 

Bus Mitra 

10 

