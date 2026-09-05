import { FigureMotion } from "./FigureMotion.tsx";

/**
 * The whole product in one line: the number that keeps changing, and the name
 * that does not.
 *
 * The ports cycle because that is the actual complaint — :3000 today, :3001 the
 * morning something else took it first. The name never moves. Both sides are
 * real text at every frame, so this reads correctly with the animation off; it
 * simply stops on the first port.
 */
const PORTS = ["3000", "5173", "8080", "4321"];

/** One 8s cycle shared by every port, so exactly one is on screen at a time. */
const CYCLE_MS = 8000;

export function HeroSwap() {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
      <FigureMotion />

      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">what you type today</p>
        <p className="mono mt-1.5 text-[19px] leading-tight text-muted line-through decoration-hairline-strong md:text-[24px]">
          http://localhost:
          <span className="inline-grid text-left align-baseline">
            {PORTS.map((port, index) => (
              <span
                aria-hidden={index > 0 ? "true" : undefined}
                className="la-port"
                key={port}
                style={{ animationDelay: `${(index * CYCLE_MS) / PORTS.length}ms` }}
              >
                {port}
              </span>
            ))}
          </span>
        </p>
      </div>

      <p aria-hidden="true" className="mono shrink-0 text-[19px] leading-none text-faint sm:mt-[1.9rem] md:text-[24px]">
        {/* The two sides sit side by side from sm up and stack below it. */}
        <span className="sm:hidden">↓</span>
        <span className="hidden sm:inline">→</span>
      </p>

      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-accent">what you type instead</p>
        <p className="mono mt-1.5 text-[19px] leading-tight text-ink md:text-[24px]">
          http://myapp<span className="text-muted">.test</span>
        </p>
      </div>
    </div>
  );
}
