# データベース設計

## ER図

```
┌─────────────────────────┐        ┌───────────────────────────────────────┐        ┌──────────────────────────────────┐
│         profiles        │        │               diagnoses               │        │       diagnosis_results          │
├─────────────────────────┤        ├───────────────────────────────────────┤        ├──────────────────────────────────┤
│ PK  id           UUID   │ 1    * │ PK  id                  UUID          │ 1    1 │ PK  id                UUID       │
│     github_username TEXT│───────▶│ FK  user_id             UUID          │───────▶│ FK  diagnosis_id      UUID UNIQ  │
│     avatar_url    TEXT  │        │ FK  paired_diagnosis_id UUID NULL UNIQ │        │     architecture_name TEXT       │
│     created_at    TSTZ  │        │     phase_label          TEXT          │        │     description       TEXT       │
└─────────────────────────┘        │     phase_type           TEXT          │        │     scores            JSONB      │
                                   │     answers              JSONB         │        │     diagram_data      JSONB      │
                                   │     created_at           TSTZ          │        │     created_at        TSTZ       │
                                   └───────────────────────────────────────┘        └──────────────────────────────────┘
                                             │ self ref
                                             └──── paired_diagnosis_id → id
```

---

## テーブル詳細

### `profiles`

Supabase `auth.users` の公開情報を保持する。`id` は `auth.users.id` と同一。

| カラム | 型 | 制約 | 説明 |
|-------|----|------|------|
| id | UUID | PK | auth.users.id と同一 |
| github_username | TEXT | NOT NULL | GitHubユーザー名 |
| avatar_url | TEXT | | GitHubアバターURL |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

---

### `diagnoses`

診断セッション。現在フェーズと過去フェーズを同一テーブルで管理する。

| カラム | 型 | 制約 | 説明 |
|-------|----|------|------|
| id | UUID | PK | |
| user_id | UUID | FK → profiles.id | |
| submission_id | UUID | NOT NULL, UNIQUE | クライアント生成のべき等キー。重複送信防止 |
| paired_diagnosis_id | UUID | FK → diagnoses.id, NULLABLE, UNIQUE | 過去診断作成時に紐づく現在診断のID。UNIQUE により1現在診断につき過去診断は1件のみ |
| phase_label | TEXT | NOT NULL | "現在" / "学生時代" / "20代前半" など |
| phase_type | TEXT | NOT NULL, CHECK IN ('current', 'past') | |
| answers | JSONB | NOT NULL | `{"1": "...", "2": "...", ..., "8": "..."}` |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

---

### `diagnosis_results`

AIが生成した診断結果。`diagnosis_id` にUNIQUE制約で1:1を保証。

| カラム | 型 | 制約 | 説明 |
|-------|----|------|------|
| id | UUID | PK | |
| diagnosis_id | UUID | FK → diagnoses.id, UNIQUE | |
| architecture_name | TEXT | NOT NULL | 例: `Tennis-Centric Monolith` |
| description | TEXT | NOT NULL | AIによるメタファー解説 |
| scores | JSONB | NOT NULL | `{"throughput": 80, "deploy_freq": 60, "fault_tolerance": 70, "observability": 55, "tech_debt": 40, "coupling": 90}` |
| diagram_data | JSONB | NOT NULL | React Flow の nodes / edges |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

---

## データフロー

```
クライアント（8問の回答）
  ↓ sessionStorage に回答を保持したまま
POST /api/diagnosis { submission_id: "uuid", answers: {"1":"...",...,"8":"..."}, phase_label, phase_type, paired_diagnosis_id? }
  ↓ diagnoses.submission_id が既存 → 既存の diagnosis_results を返す（べき等）
  ↓ 未存在 → サーバーで質問マスタを使って enrich
  [{ question: "...", concept: "...", answer: "..." }, ...]
  ↓ Mastra に渡して診断生成
diagnoses INSERT + diagnosis_results INSERT（トランザクション）
  ↓ 成功
/result/[id] にリダイレクト・sessionStorage をクリア

  ↓ 失敗（APIエラー）
ローディング画面からリトライ可能（sessionStorage の回答を再送）
```

### answers の層ごとの形式

| 層 | 形式 | 説明 |
|----|------|------|
| Client → API | `{"1": "回答", ..., "8": "回答"}` | 番号キーのみ。質問文はクライアントが持たない |
| Server → AI | `[{ question, concept, answer }]` | サーバーの質問マスタで enrich してから渡す |
| DB 保存 | `{"1": "回答", ..., "8": "回答"}` | クライアント形式のまま保存 |

> 質問マスタの定義場所: `src/modules/diagnosis/questions.ts`

---

## 設計方針

- **`paired_diagnosis_id` に UNIQUE 制約を付けた理由**: 1つの現在診断に対して過去診断が複数作成されるのを DB レベルで防ぐ。API でも作成前にチェックする二重防護
- **`paired_diagnosis_id` を持たせた理由**: `/timeline` で現在・過去のペアを `WHERE id = ? OR paired_diagnosis_id = ?` で取得するため
- **`submission_id` を持たせた理由**: サーバー成功・クライアント失敗時の再送で重複が起きないよう、クライアントが生成した UUID をべき等キーとして使用する。`UNIQUE` 制約により2回目以降は既存結果を返す
- **AI 失敗時のリトライ方針**: 回答は `sessionStorage` に保持し、失敗時はクライアントから再送する。DBに中間状態を持たせない
- **`answers` をJSONBにした理由**: 質問は8問固定で個別クエリ不要。正規化のメリットがない
- **`diagnosis_results` を別テーブルにした理由**: 診断セッションとAI生成結果のライフサイクルを分離するため
- **`diagram_data` をJSONBにした理由**: React FlowのノードとエッジはそのままJSONで保持するのが最もシンプル
