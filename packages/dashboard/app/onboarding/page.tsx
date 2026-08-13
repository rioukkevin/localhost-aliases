"use client";

import { OnboardingFlow } from "../../components/onboarding/OnboardingFlow.tsx";
import { PageBody, PageHeader } from "../../components/ui/PageHeader.tsx";

export default function OnboardingPage() {
  return (
    <PageBody>
      <PageHeader title="Setup">
        Five steps, each showing its real state — never an optimistic one. Everything that can
        be automated is; the two that cannot are the admin prompt and trusting a certificate.
      </PageHeader>
      <OnboardingFlow />
    </PageBody>
  );
}
