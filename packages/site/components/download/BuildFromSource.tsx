import { SOURCE_BUILD, SOURCE_BUILD_REQUIREMENTS } from "../../lib/product.ts";
import { GITHUB_URL } from "../site/links.ts";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { LinkButton } from "../ui/LinkButton.tsx";

/**
 * The path that exists today. There is no published release, so this is not a fallback — it
 * is the only supported way to get the app, and it is shown instead of a button that would
 * 404. It is also the honest one: you read the script that will run as root before you run it.
 */
export function BuildFromSource() {
  return (
    <div className="flex flex-col gap-4">
      <CodeBlock label="build from source" value={SOURCE_BUILD} what="commands" />

      <p className="max-w-2xl text-[12px] leading-relaxed text-faint">
        Needs {SOURCE_BUILD_REQUIREMENTS} Nothing on your Mac changes until you launch the app and accept the one admin
        prompt — <span className="mono">make install</span> only copies the bundle, and{" "}
        <span className="mono">make uninstall</span> reverses every change, including the{" "}
        <span className="mono">/etc/hosts</span> block.
      </p>

      <div className="flex flex-wrap gap-2">
        <LinkButton href="/docs/installation">Installation guide</LinkButton>
        <LinkButton href={GITHUB_URL} variant="ghost">
          Read the source first
        </LinkButton>
      </div>
    </div>
  );
}
