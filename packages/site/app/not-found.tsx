import type { Metadata } from "next";
import { LinkButton } from "../components/ui/LinkButton.tsx";
import { PatchCable } from "../components/ui/PatchCable.tsx";

export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-20 md:px-8 md:py-28">
      <p className="mono text-[11px] uppercase tracking-[0.16em] text-faint">404</p>

      <h1 className="mt-3 text-[22px] font-semibold tracking-tight text-ink md:text-[26px]">
        Nothing is patched to this address.
      </h1>
      <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
        The page you asked for does not exist. The links below do.
      </p>

      {/* The app's own vocabulary for "no server": a cable with nothing on the far end. */}
      <div className="mt-10 flex max-w-lg items-center gap-4" aria-hidden="true">
        <span className="mono text-[15px] text-faint">
          this<span className="text-faint">.page</span>
        </span>
        <span className="flex-1">
          <PatchCable status="down" size="figure" />
        </span>
        <span className="mono text-[15px] text-faint">:404</span>
      </div>

      <div className="mt-10 flex flex-wrap gap-2">
        <LinkButton href="/" variant="primary" size="md">
          Back to the landing page
        </LinkButton>
        <LinkButton href="/docs" size="md">
          Docs
        </LinkButton>
      </div>
    </div>
  );
}
