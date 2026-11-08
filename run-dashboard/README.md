# Run dashboard (self-contained; delete this folder to revert)

Dashboard artifact: https://claude.ai/artifact/KeNFHF8C3zkDKqPxMFaLgE

Refresh: `python3 run-dashboard/extract.py` (read-only on the run dir), upload the five
`data/*.json` files as artifact assets, then point each `datasets/<id>` doc's `source.url`
at the new blob and bump `updated.at`. `index.html` is the page source stored as `files/index.html`.

Works for any run: pass its folder, e.g. `python3 run-dashboard/extract.py <project>/.solofactory/runs/<id>`.
A recovery run's line is its repair plan, a feature-plan run's is its approved features, and a single-pass
run's is the pipeline (SPEC → BUILD → GATES → REVIEW → DEPLOY).

Live activity dashboard: https://claude.ai/artifact/RtDKqYzjNNt1JxyhrRchX9 (page source `live-index.html`).
Refresh: `python3 run-dashboard/extract.py <run dir> run-dashboard/live-data`, then upload `run`, `activity`,
`pulse`, `features` .json and point each `datasets/<id>` at the new blob.
Real-time local view: `run-dashboard/watch.sh <run dir>` (re-extracts on every log change), then preview
`run-dashboard-live` and open `/live.html?page=live-index.html&data=live-data&ids=run,plan,activity,pulse,features`.
