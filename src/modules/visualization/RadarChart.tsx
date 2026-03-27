"use client";

import {
  Radar,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from "recharts";
import type { Scores } from "@/types";

const AXIS_LABELS: Record<keyof Scores, string> = {
  throughput:      "Throughput",
  deploy_freq:     "Deploy Freq",
  fault_tolerance: "Fault Tolerance",
  observability:   "Observability",
  tech_debt:       "Tech Debt",
  coupling:        "Coupling",
};

interface Props {
  scores: Scores;
}

export default function RadarChart({ scores }: Props) {
  const data = (Object.keys(scores) as (keyof Scores)[]).map((key) => ({
    axis: AXIS_LABELS[key],
    value: scores[key],
  }));

  return (
    <div style={{ width: "100%", maxWidth: "480px" }}>
      <ResponsiveContainer width="100%" height={320}>
        <RechartsRadarChart data={data}>
          <PolarGrid stroke="#1E293B" />
          <PolarAngleAxis
            dataKey="axis"
            tick={{
              fill: "#94A3B8",
              fontSize: 12,
              fontFamily: "var(--font-heading)",
            }}
          />
          <Radar
            name="scores"
            dataKey="value"
            stroke="#22C55E"
            fill="#22C55E"
            fillOpacity={0.15}
          />
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}
