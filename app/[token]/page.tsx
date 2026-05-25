"use client";

import { SessionPageView } from "./SessionPageView";
import { useSessionPageController } from "./useSessionPageController";

export default function SessionPage() {
  const viewModel = useSessionPageController();
  return <SessionPageView {...viewModel} />;
}
