# NYC N Broadway Express

A live visualizer for New York City's N Broadway Express using MTA GTFS Realtime data.

## Run locally

```bash
node server.js
```

Then open:

```text
http://localhost:4173
```

The app downloads MTA static subway GTFS once, caches it locally, and reads the N/Q/R/W realtime feed for live train positions.
