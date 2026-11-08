// Demo-mode SoloFactory whose scripted agent pauses before every build turn, so a ~30s run
// stretches to a few minutes and can be watched in progress. Leaves src/ untouched.
// Usage: SOLOFACTORY_HOME=… SOLOFACTORY_ROOT=… PORT=4210 DEMO_STEP_SECONDS=20 node run-dashboard/slow-demo.mjs
import { createSoloFactoryServer } from "../src/server.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const stepMs = 1000 * Number(process.env.DEMO_STEP_SECONDS || 20);
const wait = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

const providerFactory = () => {
  const fixture = createFixtureProvider();
  return {
    ...fixture,
    async run(args) {
      if (!args.schema) await wait(stepMs, args.signal); // interview turns (schema) stay instant
      return fixture.run(args);
    },
  };
};

const port = Number(process.env.PORT || 4210);
const app = await createSoloFactoryServer({ fixtureMode: true, providerFactory });
app.server.listen(port, "127.0.0.1", () => console.log(`Slow demo SoloFactory at http://127.0.0.1:${port}`));
const stop = async () => { setTimeout(() => process.exit(1), 10_000).unref(); await app.close(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
