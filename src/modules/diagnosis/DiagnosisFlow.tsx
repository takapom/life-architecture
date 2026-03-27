"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { QUESTIONS } from "./questions";
import { useAnswers } from "./useAnswers";
import type { PhaseType } from "@/types";

interface DiagnosisFlowProps {
  mode: "current" | "past";
  phaseLabel: string;
  phaseType: PhaseType;
  pairedDiagnosisId?: string;
}

export default function DiagnosisFlow({
  mode,
  phaseLabel,
  phaseType,
  pairedDiagnosisId,
}: DiagnosisFlowProps) {
  const router = useRouter();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [quotaError, setQuotaError] = useState(false);
  const { answers, saveAnswer, clearAnswers, getStoredAnswers } = useAnswers(mode);

  const currentQuestion = QUESTIONS[currentIndex];
  const progress = ((currentIndex) / QUESTIONS.length) * 100;
  const isLastQuestion = currentIndex === QUESTIONS.length - 1;

  // Load previously saved answer for current question
  useEffect(() => {
    const stored = getStoredAnswers();
    setInputValue(stored[String(currentQuestion.id)] ?? "");
  }, [currentIndex, currentQuestion.id, getStoredAnswers]);

  const handleNext = useCallback(async () => {
    if (!inputValue.trim()) return;

    saveAnswer(currentQuestion.id, inputValue.trim());

    if (isLastQuestion) {
      // Submit
      setIsSubmitting(true);
      const allAnswers = {
        ...answers,
        [String(currentQuestion.id)]: inputValue.trim(),
      };

      try {
        const submissionId = crypto.randomUUID();
        const body = {
          submission_id: submissionId,
          answers: allAnswers,
          phase_label: phaseLabel,
          phase_type: phaseType,
          ...(pairedDiagnosisId ? { paired_diagnosis_id: pairedDiagnosisId } : {}),
        };

        const res = await fetch("/api/diagnosis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          setIsSubmitting(false);
          setQuotaError(true);
          return;
        }
        if (!res.ok) throw new Error("API error");

        const { resultId, diagnosisId } = await res.json();
        clearAnswers();

        if (phaseType === "past" && pairedDiagnosisId) {
          router.push(`/timeline/${pairedDiagnosisId}`);
        } else {
          router.push(`/result/${resultId}?diagnosisId=${diagnosisId}`);
        }
      } catch {
        setIsSubmitting(false);
        setSubmitError(true);
      }
      return;
    }

    // Transition to next question
    setIsTransitioning(true);
    setTimeout(() => {
      setCurrentIndex((i) => i + 1);
      setIsTransitioning(false);
    }, 250);
  }, [
    inputValue,
    currentQuestion.id,
    isLastQuestion,
    saveAnswer,
    answers,
    phaseLabel,
    phaseType,
    pairedDiagnosisId,
    clearAnswers,
    router,
    mode,
  ]);

  const handleRetry = useCallback(() => {
    setSubmitError(false);
    handleNext();
  }, [handleNext]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleNext();
    }
  };

  if (quotaError) {
    return (
      <div
        style={{
          minHeight: "100vh",
          backgroundColor: "var(--color-bg)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          gap: "16px",
        }}
      >
        <p style={{ fontFamily: "var(--font-heading)", color: "var(--color-accent)", fontSize: "0.8rem", letterSpacing: "0.1em" }}>
          AI_QUOTA_EXCEEDED
        </p>
        <p style={{ fontFamily: "var(--font-body)", color: "var(--color-text)", fontSize: "1rem", textAlign: "center", lineHeight: 1.7 }}>
          AI の利用上限に達しました。
          <br />
          しばらく待ってから再度お試しください。
        </p>
        <p style={{ fontFamily: "var(--font-body)", color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
          回答は保存されています。ページを再読み込みすると再送できます。
        </p>
        <button
          onClick={() => { setQuotaError(false); setIsSubmitting(false); }}
          style={{
            marginTop: "8px",
            backgroundColor: "transparent",
            color: "var(--color-accent)",
            fontFamily: "var(--font-heading)",
            fontSize: "0.85rem",
            padding: "10px 24px",
            borderRadius: "6px",
            border: "1px solid var(--color-accent)",
            cursor: "pointer",
          }}
        >
          戻る
        </button>
      </div>
    );
  }

  if (submitError) {
    return (
      <div
        style={{
          minHeight: "100vh",
          backgroundColor: "var(--color-bg)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "24px",
        }}
      >
        <p style={{ color: "var(--color-text-muted)", fontFamily: "var(--font-body)" }}>
          診断の送信中にエラーが発生しました
        </p>
        <button
          onClick={handleRetry}
          style={{
            backgroundColor: "var(--color-accent)",
            color: "#020617",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: "0.9rem",
            padding: "12px 28px",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
          }}
        >
          リトライ
        </button>
      </div>
    );
  }

  if (isSubmitting) {
    return (
      <div
        style={{
          minHeight: "100vh",
          backgroundColor: "var(--color-bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p style={{ color: "var(--color-accent)", fontFamily: "var(--font-heading)" }}>
          &gt; Analyzing architecture patterns...
        </p>
      </div>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--color-bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "640px" }}>
        {/* Progress bar */}
        <div
          style={{
            width: "100%",
            height: "3px",
            backgroundColor: "var(--color-border)",
            borderRadius: "2px",
            marginBottom: "48px",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${progress}%`,
              backgroundColor: "var(--color-accent)",
              borderRadius: "2px",
              transition: "width 250ms ease",
            }}
          />
        </div>

        {/* Question */}
        <div
          style={{
            opacity: isTransitioning ? 0 : 1,
            transform: isTransitioning ? "translateX(20px)" : "translateX(0)",
            transition: "opacity 200ms ease, transform 200ms ease",
          }}
        >
          <p
            style={{
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-heading)",
              fontSize: "0.75rem",
              marginBottom: "12px",
              letterSpacing: "0.1em",
            }}
          >
            Q{currentQuestion.id} / {QUESTIONS.length}
          </p>
          <h2
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "clamp(1.25rem, 3vw, 1.5rem)",
              color: "var(--color-text)",
              lineHeight: "1.7",
              marginBottom: "32px",
              fontWeight: 500,
            }}
          >
            {currentQuestion.question}
          </h2>

          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="思ったことをそのまま書いてください。「わからない」も OK。"
            rows={5}
            style={{
              width: "100%",
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "6px",
              color: "var(--color-text)",
              fontFamily: "var(--font-body)",
              fontSize: "1rem",
              lineHeight: "1.7",
              padding: "16px",
              resize: "vertical",
              outline: "none",
              marginBottom: "24px",
            }}
            onFocus={(e) =>
              (e.target.style.borderColor = "var(--color-accent)")
            }
            onBlur={(e) =>
              (e.target.style.borderColor = "var(--color-border)")
            }
          />

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={handleNext}
              disabled={!inputValue.trim()}
              style={{
                backgroundColor: inputValue.trim()
                  ? "var(--color-accent)"
                  : "var(--color-border)",
                color: inputValue.trim() ? "#020617" : "var(--color-text-muted)",
                fontFamily: "var(--font-heading)",
                fontWeight: 600,
                fontSize: "0.9rem",
                padding: "12px 28px",
                borderRadius: "6px",
                border: "none",
                cursor: inputValue.trim() ? "pointer" : "not-allowed",
                transition: "background-color 200ms ease, color 200ms ease",
              }}
            >
              {isLastQuestion ? "診断する" : "次へ →"}
            </button>
          </div>

          <p
            style={{
              color: "var(--color-text-muted)",
              fontSize: "0.75rem",
              fontFamily: "var(--font-body)",
              marginTop: "16px",
              textAlign: "right",
            }}
          >
            ⌘ + Enter でも進めます
          </p>
        </div>
      </div>
    </main>
  );
}
