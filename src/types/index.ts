export interface Profile {
  id: string;
  github_username: string;
  avatar_url: string | null;
  created_at: string;
}

export type PhaseType = "current" | "past";

export interface DiagnosisAnswers {
  [key: string]: string; // "1" through "8"
}

export interface Diagnosis {
  id: string;
  user_id: string;
  submission_id: string;
  paired_diagnosis_id: string | null;
  phase_label: string;
  phase_type: PhaseType;
  answers: DiagnosisAnswers;
  created_at: string;
}

export interface Scores {
  throughput: number;
  deploy_freq: number;
  fault_tolerance: number;
  observability: number;
  tech_debt: number;
  coupling: number;
}

export type NodeType = "component" | "service" | "database" | "external";

export interface DiagramNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: {
    label: string;
    description?: string;
  };
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface DiagramData {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagnosisResult {
  id: string;
  diagnosis_id: string;
  architecture_name: string;
  description: string;
  scores: Scores;
  diagram_data: DiagramData;
  created_at: string;
}

export interface DiagnosisWithResult extends Diagnosis {
  diagnosis_results: DiagnosisResult | null;
}

// Used on the result page
export interface ResultPageData {
  result: DiagnosisResult;
  diagnosis: Diagnosis;
}

// AI input format (enriched on server)
export interface EnrichedAnswer {
  question: string;
  concept: string;
  answer: string;
}

export interface DiagnosisAIInput {
  phase_label: string;
  phase_type: PhaseType;
  answers: EnrichedAnswer[];
}

// POST /api/diagnosis request body
export interface DiagnosisRequestBody {
  submission_id: string;
  answers: DiagnosisAnswers;
  phase_label: string;
  phase_type: PhaseType;
  paired_diagnosis_id?: string;
}

// Partial type used in history list
export interface DiagnosisSummary {
  id: string;
  phase_label: string;
  phase_type: string;
  paired_diagnosis_id: string | null;
  created_at: string;
  diagnosis_results: { id: string; architecture_name: string } | null;
}
