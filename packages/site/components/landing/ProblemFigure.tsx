import type { ReactNode } from "react";
import { FigureFrame } from "./FigureFrame.tsx";

/**
 * The problem, as the tab bar states it: five projects, five numbers, and no way
 * to tell them apart without opening them. The scan is the animation — one tab
 * "opened" at a time, in turn — because that is literally the behaviour the copy
 * describes. At rest nothing is highlighted, which is the same argument.
 */
const PORTS = [
  "localhost:3000",
  "localhost:5173",
  "localhost:8080",
  "localhost:4321",
  "localhost:3001",
];

const NAMES = ["shop.test", "api.test", "docs.test", "admin.test", "blog.test"];

/** The one you were looking for. Named, it is the third row; numbered, it is a coin toss. */
const WANTED = "docs.test";

/** One 7s cycle, five tabs: the scan takes 6s and leaves a beat before it repeats. */
const STEP_MS = 1200;

function Tab({ children, favicon }: { children: ReactNode; favicon?: "accent" }) {
  return (
    <span className="flex items-center gap-2.5 overflow-hidden">
      <span
        aria-hidden="true"
        className={
          favicon === "accent"
            ? "h-2.5 w-2.5 shrink-0 border border-accent bg-accent"
            : "h-2.5 w-2.5 shrink-0 border border-hairline-strong bg-canvas"
        }
      />
      <span className="mono truncate text-[12px] md:text-[13px]">{children}</span>
    </span>
  );
}

export function ProblemFigure() {
  return (
    <FigureFrame
      label="the tab bar"
      meta="5 projects open"
      caption={
        <>
          Numbered, every tab looks the same and you open them in turn until one is the project you
          meant. Named, the tab bar is an index: <span className="mono">{WANTED}</span> is the one
          you wanted, and it is still that name tomorrow, whatever port the dev server grabs.
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            Without aliases
          </p>
          <ul className="mt-2.5 flex flex-col gap-1.5">
            {PORTS.map((port, index) => (
              <li
                key={port}
                className="la-probe border border-hairline bg-sunken px-2.5 py-2 text-muted"
                style={{ animationDelay: `${index * STEP_MS}ms` }}
              >
                <Tab>{port}</Tab>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            Five ports, no names. Cookies ignore the port, so all five share one{" "}
            <span className="mono">localhost</span> cookie jar too.
          </p>
        </div>

        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            With aliases
          </p>
          <ul className="mt-2.5 flex flex-col gap-1.5">
            {NAMES.map((name) => {
              const wanted = name === WANTED;
              return (
                <li
                  key={name}
                  className={`relative border px-2.5 py-2 ${
                    wanted
                      ? "border-hairline-strong bg-raised text-ink"
                      : "border-hairline bg-sunken text-muted"
                  }`}
                >
                  {wanted ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-[2px] bg-accent"
                    />
                  ) : null}
                  <Tab favicon={wanted ? "accent" : undefined}>
                    {name.replace(".test", "")}
                    <span className={wanted ? "text-muted" : "text-faint"}>.test</span>
                  </Tab>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            A separate origin each, so history, autofill and cookies finally key on something that
            means the project.
          </p>
        </div>
      </div>
    </FigureFrame>
  );
}
