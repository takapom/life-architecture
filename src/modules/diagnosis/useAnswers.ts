"use client";

import { useState, useCallback } from "react";
import type { DiagnosisAnswers } from "@/types";

const STORAGE_KEY_PREFIX = "life-arch-answers";

export function useAnswers(mode: "current" | "past") {
  const storageKey = `${STORAGE_KEY_PREFIX}-${mode}`;

  const getInitialAnswers = (): DiagnosisAnswers => {
    if (typeof window === "undefined") return {};
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  };

  const [answers, setAnswers] = useState<DiagnosisAnswers>(getInitialAnswers);

  const saveAnswer = useCallback(
    (questionId: number, value: string) => {
      setAnswers((prev) => {
        const next = { ...prev, [String(questionId)]: value };
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // sessionStorage not available
        }
        return next;
      });
    },
    [storageKey]
  );

  const clearAnswers = useCallback(() => {
    setAnswers({});
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // sessionStorage not available
    }
  }, [storageKey]);

  const getStoredAnswers = useCallback((): DiagnosisAnswers => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  }, [storageKey]);

  return { answers, saveAnswer, clearAnswers, getStoredAnswers };
}
