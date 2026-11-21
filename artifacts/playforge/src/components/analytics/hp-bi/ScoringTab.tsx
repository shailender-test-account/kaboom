import type { HpBiDashboard } from "./types";
import { Panel } from "./ui";

export default function ScoringTab({ data }: { data: HpBiDashboard }) {
  const s = data.scoring;
  const rules: [string, string, string][] = [["Hot", s.hotRule, "#E8892B"], ["Warm", s.warmRule, "#d4a017"], ["Order value", s.orderValueRule, "#0096D6"]];
  return (
    <div className="grid grid-cols-12 gap-3 hpbi-fade" data-testid="tab-content-scoring">
      <Panel className="col-span-12 lg:col-span-7" title="Journey points and intent model" note="Account journey score is the sum of stored contact engagement points. The formula below explains separate global intent scores; neither score replaces Hot/Warm purchase qualification.">
        <div className="rounded-md bg-[#0B2A4A] text-white p-4 font-mono text-[13px] leading-relaxed" data-testid="text-score-formula">{s.formula}</div>
        <p className="text-xs text-[#41586e] mt-3" data-testid="text-score-description">{data.quality.scoreDescription}</p>
        <ol className="mt-4 divide-y divide-[#e3ebf2]">
          {s.components.map((c, i) => (
            <li key={c.name} className="flex gap-3 py-2.5" data-testid={`row-score-component-${i}`}>
              <span className="w-6 h-6 shrink-0 rounded-full bg-[#d8eefa] text-[#05628f] text-xs font-semibold flex items-center justify-center">{i + 1}</span>
              <div><div className="text-sm font-semibold text-[#0B2A4A]">{c.name}</div><div className="text-xs text-[#41586e]">{c.description}</div></div>
            </li>
          ))}
          {s.components.length === 0 && <li className="py-3 text-xs text-[#5d7388]">The server returned no score components.</li>}
        </ol>
      </Panel>
      <div className="col-span-12 lg:col-span-5 flex flex-col gap-3">
        <Panel title="Account priority · freshness-adjusted">
          <p className="text-xs text-[#41586e]">Forms 65% · Journey behaviour 25% · Monitoring 10%. Hot ≥65 requires fresh explicit purchase evidence; otherwise ≥35 is Warm, below 35 Cold.</p>
          <p className="mt-2 text-xs text-[#41586e]">Forms keep full weight for 30 days then halve every 60 days. Journey keeps full weight for 14 days then halves every 30 days. Monitoring halves every 30 days from the original event date. Expired purchase windows need reconfirmation. Historical fiscal leads and stored journey points do not decay.</p>
        </Panel>
        <Panel title="Historical lead qualification and value rules">
          <div className="space-y-3">
            {rules.map(([n, t, c]) => (
              <div key={n} className="border-l-4 pl-3" style={{ borderColor: c }} data-testid={`text-rule-${n.toLowerCase().replace(" ", "-")}`}>
                <div className="text-[11px] uppercase tracking-wider font-semibold text-[#0B2A4A]">{n}</div>
                <div className="text-xs text-[#41586e] leading-snug">{t}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Current-score thresholds" note="Apply to the existing contact intent score, not to HP lead Hot/Warm qualification.">
          {Object.keys(s.thresholds).length === 0 ? <p className="text-xs text-[#5d7388]">No thresholds supplied.</p> :
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {Object.entries(s.thresholds).map(([k, v]) => (<div key={k} className="contents"><dt className="text-[#41586e]">{k}</dt><dd className="text-right tabular-nums font-semibold text-[#0B2A4A]">{v}</dd></div>))}
            </dl>}
        </Panel>
        <Panel title="Data note"><p className="text-xs text-[#41586e]" data-testid="text-quality-note">{data.quality.note}</p></Panel>
      </div>
    </div>
  );
}
