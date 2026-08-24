import { PatchCable, type CableStatus } from "../ui/PatchCable.tsx";

const ROWS: { name: string; ip: string; port: number; status: CableStatus }[] = [
  { name: "myapp", ip: "127.0.0.2", port: 3000, status: "up" },
  { name: "api.myapp", ip: "127.0.0.3", port: 3001, status: "up" },
  { name: "docs", ip: "127.0.0.4", port: 4321, status: "down" },
];

/**
 * A still patchbay: three names, three cables, three ports. Doubles as the hero
 * when the rendered video is not in `public/` yet, so the page is never empty.
 */
export function PatchbayFigure() {
  return (
    <div className="border border-hairline bg-canvas">
      <div className="flex items-center gap-x-3 border-b border-hairline bg-raised px-4 py-2.5 md:px-6">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">Patchbay</h3>
        <span className="mono text-[11px] text-muted">3 aliases · 2 live</span>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
          Port
        </span>
      </div>

      <ul className="divide-y divide-hairline">
        {ROWS.map((row) => (
          <li key={row.name} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 md:px-6">
            <span
              className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                row.status === "up" ? "border-live/40" : "border-down/40"
              }`}
            >
              <span
                className={`block h-1.5 w-1.5 rounded-full ${
                  row.status === "up" ? "dot-live bg-live" : "bg-down"
                }`}
              />
            </span>

            <span className="flex-1 lg:w-[18rem] lg:flex-none">
              <span className="mono block text-[17px] font-medium leading-tight text-ink md:text-[19px]">
                {row.name}
                <span className="text-faint">.test</span>
              </span>
              <span className="mono mt-1 block text-[11px] text-faint">
                {row.ip}:80 → 127.0.0.1:{row.port}
              </span>
            </span>

            <span className="order-last basis-full pl-[1.9rem] sm:order-none sm:basis-0 sm:grow sm:pl-0">
              <PatchCable status={row.status} />
            </span>

            <span className="mono w-[4.5rem] text-right text-[15px] text-ink md:text-[17px]">
              <span className="text-faint">:</span>
              {row.port}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
