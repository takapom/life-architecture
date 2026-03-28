/**
 * DEV ONLY — テスト用結果ページ
 * APIを叩かずに ResultView の UI を確認するためのページ。
 * URL: /test/result
 */
import ResultView from "@/modules/result/ResultView";
import type { DiagnosisResult, Diagnosis } from "@/types";

const mockDiagnosis: Diagnosis = {
  id: "mock-diagnosis-id",
  user_id: "mock-user-id",
  submission_id: "mock-submission-id",
  paired_diagnosis_id: null,
  phase_label: "現在",
  phase_type: "current",
  answers: {
    "1": "個人開発と仕事を半々でやってる。最近はAIプロダクト開発に全振り気味",
    "2": "チームメンバーには頼られることが多い。自分はあまり人に頼れないタイプ",
    "3": "まず状況を整理してから動く。パニックにはならないけど意思決定が遅い",
    "4": "テストコードを全然書けてない。あとドキュメント整備も後回しにしがち",
    "5": "週1〜2くらいで新しいツールや技術を試してる。飽き性なのかも",
    "6": "タスクを詰め込みすぎてキャパオーバーになる。バッファの取り方が下手",
    "7": "コードが雑になってきたら調子悪いサイン。集中力の持続が指標になってる",
    "8": "ずっとβ版みたいな感じ。常に改善中",
  },
  created_at: new Date().toISOString(),
};

const mockResult: DiagnosisResult = {
  id: "mock-result-id",
  diagnosis_id: "mock-diagnosis-id",
  architecture_name: "Beta-Driven Async Monolith",
  description:
    "Throughput は高め。個人開発と仕事を並走させてるあたり、マルチスレッドで動いてはいるんだが、スケジューリングがバーストしすぎてキャパオーバーになるのはよくあるパターンだな。\n\nFault Tolerance は中くらい。パニックにはならない点は評価できるけど、意思決定レイテンシが高めなのはボトルネックになりうる。本番環境で障害が起きたとき、落ち着いてても遅かったら意味ないからな。\n\nTech Debt については、テストコードなし・ドキュメントなしはもはやレガシーシステムの予備軍だ。「後でやる」は永遠に来ないって、お前自身が一番わかってるだろ。\n\nObservability は面白い。コードの質で自分の状態を観測してるのはエンジニアらしいセルフモニタリングだな。それが機能してる間はいいけど、燃え尽きたときに気づけるかが問題だ。\n\nβ版と自己評価してる点は正直で好感が持てる。ずっとβのままリリースしないシステムは技術的負債が溜まる一方なので、どこかでv1.0を切る判断が必要だぞ。",
  scores: {
    throughput: 72,
    deploy_freq: 68,
    fault_tolerance: 45,
    observability: 61,
    tech_debt: 28,
    coupling: 55,
  },
  diagram_data: {
    nodes: [
      {
        id: "api-gateway",
        type: "external",
        position: { x: 300, y: 50 },
        data: {
          label: "API Gateway",
          description: "外部との接点 - 仕事・チームとの関わり",
        },
      },
      {
        id: "core-service",
        type: "component",
        position: { x: 300, y: 200 },
        data: {
          label: "Core Service",
          description: "個人開発 × 仕事のメイン処理",
        },
      },
      {
        id: "cicd",
        type: "service",
        position: { x: 80, y: 370 },
        data: {
          label: "CI/CD Pipeline",
          description: "週1〜2の新技術挑戦サイクル",
        },
      },
      {
        id: "tech-debt-module",
        type: "service",
        position: { x: 300, y: 370 },
        data: {
          label: "Tech Debt Module",
          description: "テスト・ドキュメント未整備の負債",
        },
      },
      {
        id: "fault-handler",
        type: "service",
        position: { x: 520, y: 370 },
        data: {
          label: "Fault Handler",
          description: "障害時の整理→対応フロー",
        },
      },
      {
        id: "primary-db",
        type: "database",
        position: { x: 300, y: 530 },
        data: {
          label: "Primary DB",
          description: "経験・知識の蓄積ストア",
        },
      },
      {
        id: "monitoring",
        type: "database",
        position: { x: 520, y: 530 },
        data: {
          label: "Monitoring",
          description: "コード品質による自己観測",
        },
      },
    ],
    edges: [
      { id: "e1", source: "api-gateway", target: "core-service", label: "REST" },
      { id: "e2", source: "core-service", target: "cicd", label: "Async" },
      { id: "e3", source: "core-service", target: "tech-debt-module", label: "Backlog" },
      { id: "e4", source: "core-service", target: "fault-handler", label: "Event" },
      { id: "e5", source: "core-service", target: "primary-db", label: "DB Write" },
      { id: "e6", source: "fault-handler", target: "monitoring", label: "Metrics" },
      { id: "e7", source: "primary-db", target: "monitoring", label: "Query" },
    ],
    overview: {
      headline: "仕事と個人開発を Core Service に集約して回す、Monolith 主導の人生システム。",
      composition: "Core Service を軸に、CI/CD 的な挑戦サイクル、Fault Handler 的な障害対応、Monitoring 的な自己観測が結びついている。",
    },
    flows: [
      {
        id: "daily-workload",
        access: "Daily Workload",
        summary: "普段の仕事や個人開発の負荷が入ると、コア処理で優先度を裁いて経験として蓄積し、最後に自己観測へ流れていく。",
        steps: [
          {
            node_id: "api-gateway",
            title: "外部から要求を受ける",
            detail: "仕事やチームからの依頼、個人開発の期待値がここに集中する。",
          },
          {
            node_id: "core-service",
            title: "優先度を裁いてメイン処理へ寄せる",
            detail: "仕事と個人開発を半々で回しつつ、今どちらを優先するかを決めている。",
          },
          {
            node_id: "primary-db",
            title: "経験として書き込む",
            detail: "やったことや学びが蓄積されて、次の判断材料になっていく。",
          },
          {
            node_id: "monitoring",
            title: "状態を自己観測する",
            detail: "コード品質や集中力の落ち方を見て、今の自分のコンディションを測っている。",
          },
        ],
      },
      {
        id: "incident-recovery",
        access: "Incident Event",
        summary: "想定外のトラブルが起きると、コア処理から障害対応へ切り替わり、観測系にシグナルを送って持ち直す流れになる。",
        steps: [
          {
            node_id: "api-gateway",
            title: "異常入力を受ける",
            detail: "タスク詰め込みや想定外の要求が、入口で一気に流れ込んでくる。",
          },
          {
            node_id: "core-service",
            title: "状況整理モードへ切り替える",
            detail: "パニックにはならないが、まず整理してから動こうとする。",
          },
          {
            node_id: "fault-handler",
            title: "障害対応を実行する",
            detail: "落ち着いて対応する一方で、意思決定レイテンシがボトルネックになりやすい。",
          },
          {
            node_id: "monitoring",
            title: "調子の変化を検知する",
            detail: "コードの荒れ方や集中の切れ方から、限界に近づいていることを察知する。",
          },
        ],
      },
    ],
  },
  created_at: new Date().toISOString(),
};

export default function TestResultPage() {
  return (
    <ResultView
      result={mockResult}
      diagnosis={mockDiagnosis}
      isOwner={true}
      isLoggedIn={true}
    />
  );
}
