import { getWorkflowIndex } from '@netsuite/netsuite-data';

export default function HomePage() {
  const workflows = getWorkflowIndex();

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Next App Router Shell</p>
        <h1>Future Atlas-backed application shell</h1>
        <p className="muted">
          This branch keeps the Next app intentionally minimal. It proves App Router can import the shared
          NetSuite data layer without becoming the primary docs runtime yet.
        </p>
        <div className="pillRow">
          <span className="pill">{workflows.length} cached workflow bases available</span>
          <span className="pill">Shared packages wired</span>
        </div>
      </section>
    </main>
  );
}
