# データベース設計

## ER図

```
┌─────────────────────────┐        ┌──────────────────────────────────┐        ┌────────────────────────────────┐
│         profiles        │        │            diagnoses             │        │       diagnosis_results        │
├─────────────────────────┤        ├──────────────────────────────────┤        ├────────────────────────────────┤
│ PK  id           UUID   │ 1    * │ PK  id              UUID         │ 1    1 │ PK  id              UUID       │
│     github_username TEXT│───────▶│ FK  user_id         UUID        │───────▶│ FK  diagnosis_id    UUID UNIQ  │
│     avatar_url    TEXT  │        │     phase_label      TEXT        │        │     architecture_name TEXT     │
│     created_at    TSTZ  │        │     phase_type       TEXT        │        │     description     TEXT       │
└─────────────────────────┘        │     answers          JSONB       │        │     scores          JSONB      │
                                   │     status           TEXT        │        │     diagram_data    JSONB      │
                                   │     created_at       TSTZ        │        │     created_at      TSTZ       │
                                   │     updated_at       TSTZ        │        └────────────────────────────────┘
                                   └──────────────────────────────────┘
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
| phase_label | TEXT | NOT NULL | "現在" / "学生時代" / "20代前半" など |
| phase_type | TEXT | NOT NULL | `current` or `past` |
| answers | JSONB | | `{"1": "...", "2": "...", ..., "8": "..."}` |
| status | TEXT | NOT NULL DEFAULT 'in_progress' | `in_progress` or `completed` |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

---

### `diagnosis_results`

AIが生成した診断結果。`diagnosis_id` にUNIQUE制約を付け、再生成不可の1:1設計。

| カラム | 型 | 制約 | 説明 |
|-------|----|------|------|
| id | UUID | PK | |
| diagnosis_id | UUID | FK → diagnoses.id, UNIQUE | |
| architecture_name | TEXT | NOT NULL | 例: `Tennis-Centric Monolith` |
| description | TEXT | NOT NULL | AIによるメタファー解説 |
| scores | JSONB | NOT NULL | `{"agility": 80, "availability": 60, ...}` |
| diagram_data | JSONB | NOT NULL | React Flow の nodes / edges |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

---

## 設計方針

- **`answers` をJSONBにした理由**: 質問は8問固定で個別クエリ不要。正規化のメリットがない
- **`diagnosis_results` を別テーブルにした理由**: AI生成は非同期のため、セッションと結果のライフサイクルが異なる
- **`diagram_data` をJSONBにした理由**: React FlowのノードとエッジはそのままJSONで保持するのが最もシンプル
- **再生成不可**: `diagnosis_id` のUNIQUE制約により1:1固定
