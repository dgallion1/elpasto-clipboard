"use client";

import { useRef, useState } from "react";
import { PasteZoneContent } from "./paste-zone/PasteZoneContent";
import type { PasteZoneProps, ImportSessionsResult } from "./paste-zone/types";
import type { ImportEntry } from "@/hooks/useSessionHistory";
import { usePasteZoneActions } from "./paste-zone/usePasteZoneActions";

export function PasteZone(props: PasteZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<ImportEntry[] | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSessionsResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const actions = usePasteZoneActions({
    ...props,
    fileInputRef,
    setError,
    setIsClearing,
    setIsDragOver,
    onSessionImportDetected: setPendingImport,
  });

  const isFocused = props.focusedZone === props.zone;
  const isHidden = props.focusedZone !== null && !isFocused;

  const confirmImport = async () => {
    if (!pendingImport || !props.onImportSessions) {
      setPendingImport(null);
      return;
    }
    setImportResult(null);
    setIsImporting(true);
    try {
      const result = await props.onImportSessions(pendingImport);
      setImportResult(result);
    } catch {
      // keep banner visible on error; future task can surface error state
    } finally {
      setIsImporting(false);
      setPendingImport(null);
    }
  };

  const cancelImport = () => {
    setPendingImport(null);
    setImportResult(null);
  };

  return (
    <PasteZoneContent
      {...props}
      isFocused={isFocused}
      isHidden={isHidden}
      error={error}
      fileInputRef={fileInputRef}
      isClearing={isClearing}
      isDragOver={isDragOver}
      pendingImport={pendingImport}
      isImporting={isImporting}
      importResult={importResult}
      onConfirmImport={() => void confirmImport()}
      onCancelImport={cancelImport}
      {...actions}
    />
  );
}
