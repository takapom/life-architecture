import DiagnosisFlow from "@/modules/diagnosis/DiagnosisFlow";

export default function DiagnosisPage() {
  return (
    <DiagnosisFlow
      mode="current"
      phaseLabel="現在"
      phaseType="current"
    />
  );
}
