import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── Supabase接続 ──────────────────────────────────────────────
// このURLとanonキーはフロントエンドに直接書いて問題ない「公開用」の値です
const supabase = createClient(
  "https://sndehbhymphfpqjurcar.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNuZGVoYmh5bXBoZnBxanVyY2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NzQ5MzcsImV4cCI6MjA5NzQ1MDkzN30.MhpHkKYCe-_vmZ42nVWeUjmb0WjgLShmWgnM12cKPNw"
);

// ─── 管理画面の簡易パスワード（本格的な安全対策ではなく、知らない人が誤って／気軽に管理画面を
// 触ってしまうのを防ぐための簡易的なものです。変えたい場合はこの行の文字列を書き換えてください） ──
const ADMIN_PASSWORD = "pollr-admin-2026";
const ADMIN_UNLOCK_KEY = "polling_app_admin_unlocked";

// ─── 投票者ID（ログイン機能実装までの仮の本人識別。同一ブラウザ内でのみ有効） ──
const VOTER_ID_KEY = "polling_app_voter_id";
function getVoterId() {
  try {
    let id = localStorage.getItem(VOTER_ID_KEY);
    if (!id) {
      id = "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(VOTER_ID_KEY, id);
    }
    return id;
  } catch {
    return "v_anon";
  }
}

// ─── コメントの「いいね」済みID（ログイン機能実装までの仮対応。同一ブラウザ内でのみ有効） ──
const LIKED_KEY = "polling_app_liked_comments";
function getLikedIds() {
  try {
    const raw = localStorage.getItem(LIKED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveLikedIds(set) {
  try {
    localStorage.setItem(LIKED_KEY, JSON.stringify([...set]));
  } catch {}
}

// 選択した内容が正解と完全一致するか判定（複数選択は全選択肢が一致して初めて的中）
function isCorrectSelection(poll, selectedOptions) {
  if (!poll || !poll.resolved) return null;
  const correct = poll.correctOptions || [];
  if (correct.length === 0) return null;
  const a = [...(selectedOptions || [])].sort((x, y) => x - y);
  const b = [...correct].sort((x, y) => x - y);
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// 投票記録1件分の獲得／損失ポイントを計算する（未確定の質問はnull）
function pointsForRecord(poll, selectedOptions) {
  const correct = isCorrectSelection(poll, selectedOptions);
  if (correct === null) return null;
  return correct ? (poll.correctPoints || 0) : -(poll.incorrectPoints || 0);
}

// 総合スコア（的中率＋鋭い視点レートの合算）関連
// 重みは意図的に非公開にする（ユーザーには「両方を反映する」とだけ伝える）
const MIN_SCORE_SAMPLE = 10;
const SCORE_WEIGHT_CORRECT = 0.6;
const SCORE_WEIGHT_INSIGHT = 0.4;

function computeCombinedScore(total, correctCount, reasonsWritten, reasonsWithInsight) {
  if (total < MIN_SCORE_SAMPLE) return null;
  const rate = total > 0 ? (correctCount / total) * 100 : 0;
  const insightRate = reasonsWritten > 0 ? (reasonsWithInsight / reasonsWritten) * 100 : null;
  const score = insightRate !== null ? rate * SCORE_WEIGHT_CORRECT + insightRate * SCORE_WEIGHT_INSIGHT : rate;
  return Math.round(score);
}

// 全ユーザーの的中率・ポイント・総合スコアを集計する（管理画面用）
function computeLeaderboard(data) {
  const byUser = {};
  (data.voteRecords || []).forEach((r) => {
    const poll = data.polls.find((p) => p.id === r.pollId);
    if (!poll) return;
    const correct = isCorrectSelection(poll, r.selectedOptions);
    if (correct === null) return; // まだ正解未確定の質問は集計しない
    if (!byUser[r.voterId]) byUser[r.voterId] = { voterId: r.voterId, total: 0, correctCount: 0, points: 0, reasonsWritten: 0, reasonsWithInsight: 0 };
    byUser[r.voterId].total += 1;
    if (correct) byUser[r.voterId].correctCount += 1;
    byUser[r.voterId].points += pointsForRecord(poll, r.selectedOptions) || 0;
    if (r.reason && r.reason.trim()) {
      byUser[r.voterId].reasonsWritten += 1;
      if (insightCountFor(data, r.id) > 0) byUser[r.voterId].reasonsWithInsight += 1;
    }
  });

  const profileMap = {};
  (data.profiles || []).forEach((p) => { profileMap[p.id] = p; });

  return Object.values(byUser)
    .map((u) => {
      const insightRate = u.reasonsWritten > 0 ? Math.round((u.reasonsWithInsight / u.reasonsWritten) * 100) : null;
      return {
        ...u,
        displayName: profileMap[u.voterId]?.display_name || "（不明なユーザー）",
        avatarUrl: profileMap[u.voterId]?.avatar_url || null,
        rate: u.total > 0 ? Math.round((u.correctCount / u.total) * 100) : 0,
        insightRate,
        combinedScore: computeCombinedScore(u.total, u.correctCount, u.reasonsWritten, u.reasonsWithInsight),
      };
    })
    .sort((a, b) => b.points - a.points);
}

// ─── 公開スケジュール（開始日時・終了日時）関連のヘルパー ──────────
// activeフラグ（管理者の手動スイッチ）に加えて、開始/終了日時が設定されていれば
// その期間外は自動的に投票できない状態にする
function isPollOpen(poll) {
  if (!poll.active) return false;
  const now = Date.now();
  if (poll.startsAt && now < new Date(poll.startsAt).getTime()) return false;
  if (poll.endsAt && now > new Date(poll.endsAt).getTime()) return false;
  return true;
}

function pollStatusLabel(poll) {
  if (!poll.active) return { text: "非公開", color: palette.muted };
  const now = Date.now();
  if (poll.startsAt && now < new Date(poll.startsAt).getTime()) return { text: "開始前", color: palette.accent };
  if (poll.endsAt && now > new Date(poll.endsAt).getTime()) return { text: "終了", color: palette.danger };
  return { text: "公開中", color: palette.green };
}

// ─── 鋭い視点機能 関連のヘルパー ───────────────────────────────
const INSIGHT_PERIOD_DAYS = 7;

function getProfileName(data, userId) {
  const p = (data.profiles || []).find((pr) => pr.id === userId);
  return p?.display_name || "（不明なユーザー）";
}

function getProfileAvatar(data, userId) {
  const p = (data.profiles || []).find((pr) => pr.id === userId);
  return p?.avatar_url || null;
}

// この質問の理由コメントへの「鋭い視点」評価がまだ受付期間内かどうか
function isInsightPeriodOpen(poll) {
  if (!poll.resolved || !poll.resolvedAt) return false;
  const deadline = new Date(poll.resolvedAt).getTime() + INSIGHT_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() <= deadline;
}

// 理由コメントがまだ編集可能か（結果確定 or 質問者が設定した変更期限のどちらか早い方でロック）
function canEditReason(poll) {
  if (poll.resolved) return false;
  if (poll.reasonLockAt && Date.now() >= new Date(poll.reasonLockAt).getTime()) return false;
  return true;
}

function insightCountFor(data, voteRecordId) {
  return (data.insightVotes || []).filter((v) => v.voteRecordId === voteRecordId).length;
}

function hasRatedInsight(data, voteRecordId, raterId) {
  return (data.insightVotes || []).some((v) => v.voteRecordId === voteRecordId && v.raterId === raterId);
}

// ─── 議論コメントの評価（鋭い視点・Δ）関連のヘルパー ──────────────
function commentEvalCount(data, commentId, kind) {
  return (data.commentEvaluations || []).filter((e) => e.commentId === commentId && e.kind === kind).length;
}

function hasRatedComment(data, commentId, raterId, kind) {
  return (data.commentEvaluations || []).some((e) => e.commentId === commentId && e.raterId === raterId && e.kind === kind);
}

// ネストしたコメントツリーをフラットな配列に展開する（スレッド参加判定などに使う）
function flattenComments(list) {
  let out = [];
  (list || []).forEach((c) => {
    out.push(c);
    if (c.replies && c.replies.length) out = out.concat(flattenComments(c.replies));
  });
  return out;
}

// ISO文字列 ⇔ <input type="datetime-local"> の値（ローカル時刻）の変換
function toDatetimeLocalValue(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(isoString) {
  if (!isoString) return null;
  return new Date(isoString).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// フラットなコメント一覧（parent_idで親を指す形）を、ネストしたツリーに変換する
function buildCommentTree(flat, likedIds) {
  const byId = {};
  flat.forEach((c) => {
    byId[c.id] = {
      id: c.id,
      author: c.author,
      avatarUrl: c.avatar_url || null,
      userId: c.user_id || null,
      text: c.text,
      ts: new Date(c.created_at).getTime(),
      likes: c.likes,
      liked: likedIds.has(c.id),
      replies: [],
    };
  });
  const roots = [];
  flat.forEach((c) => {
    if (c.parent_id && byId[c.parent_id]) {
      byId[c.parent_id].replies.push(byId[c.id]);
    } else if (!c.parent_id) {
      roots.push(byId[c.id]);
    }
  });
  return roots.reverse(); // 新しい投稿を上に
}

// Supabaseから全データを取得し、画面コンポーネントが使う形（旧localStorage版と同じ形）に組み立てる
async function fetchAllData() {
  const [catsRes, pollsRes, votesRes, commentsRes, profilesRes, postsRes, insightRes, commentEvalRes, talkersRes] = await Promise.all([
    supabase.from("categories").select("*").order("number", { ascending: true }),
    supabase.from("polls").select("*").order("created_at", { ascending: true }),
    supabase.from("vote_records").select("*"),
    supabase.from("comments").select("*").order("created_at", { ascending: true }),
    supabase.from("profiles").select("*"),
    supabase.from("posts").select("*").order("created_at", { ascending: false }),
    supabase.from("insight_votes").select("*"),
    supabase.from("comment_evaluations").select("*"),
    supabase.from("main_talkers").select("*"),
  ]);

  if (catsRes.error) throw catsRes.error;
  if (pollsRes.error) throw pollsRes.error;
  if (votesRes.error) throw votesRes.error;
  if (commentsRes.error) throw commentsRes.error;
  if (profilesRes.error) throw profilesRes.error;
  if (postsRes.error) throw postsRes.error;
  if (insightRes.error) throw insightRes.error;
  if (commentEvalRes.error) throw commentEvalRes.error;
  if (talkersRes.error) throw talkersRes.error;

  const voteRecords = votesRes.data.map((r) => ({
    id: r.id,
    pollId: r.poll_id,
    voterId: r.voter_id,
    selectedOptions: r.selected_options,
    reason: r.reason || "",
    ts: new Date(r.created_at).getTime(),
  }));

  const likedIds = getLikedIds();

  const categories = catsRes.data.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    number: c.number,
    comments: buildCommentTree(commentsRes.data.filter((cm) => cm.category_id === c.id), likedIds),
  }));

  const polls = pollsRes.data.map((p) => {
    const votes = p.options.map((_, i) =>
      voteRecords.filter((r) => r.pollId === p.id && r.selectedOptions.includes(i)).length
    );
    return {
      id: p.id,
      question: p.question,
      options: p.options,
      votes,
      multiple: p.multiple,
      active: p.active,
      categoryId: p.category_id,
      resolved: p.resolved,
      correctOptions: p.correct_options || [],
      startsAt: p.starts_at || null,
      endsAt: p.ends_at || null,
      correctPoints: p.correct_points ?? 10,
      incorrectPoints: p.incorrect_points ?? 0,
      resolvedAt: p.resolved_at || null,
      reasonLockAt: p.reason_lock_at || null,
    };
  });

  const nextCategoryNumber = categories.length > 0 ? Math.max(...categories.map((c) => c.number)) + 1 : 1;

  const posts = postsRes.data.map((p) => ({
    id: p.id,
    author: p.author,
    avatarUrl: p.avatar_url || null,
    text: p.text,
    likes: p.likes,
    liked: likedIds.has(p.id),
    ts: new Date(p.created_at).getTime(),
  }));

  const insightVotes = insightRes.data.map((v) => ({
    id: v.id,
    voteRecordId: v.vote_record_id,
    raterId: v.rater_id,
  }));

  return { categories, polls, voteRecords, nextCategoryNumber, profiles: profilesRes.data, posts, insightVotes, commentEvaluations: commentEvalRes.data.map((e) => ({ id: e.id, commentId: e.comment_id, raterId: e.rater_id, kind: e.kind })), mainTalkers: talkersRes.data.map((t) => ({ id: t.id, categoryId: t.category_id, userId: t.user_id })) };
}

const CATEGORY_COLORS = ["#e8ff47", "#4dff91", "#ff8fd6", "#7ec8ff", "#ff9d4d", "#c792ff", "#ff6b6b", "#5ce1e6"];

const palette = {
  bg: "#0d0d0d",
  card: "#161616",
  border: "#2a2a2a",
  accent: "#e8ff47",
  accentDim: "#b8cc2f",
  text: "#f0f0f0",
  muted: "#888",
  danger: "#ff4d4d",
  green: "#4dff91",
};

const styles = {
  app: {
    minHeight: "100vh",
    background: palette.bg,
    color: palette.text,
    fontFamily: "'DM Mono', 'Courier New', monospace",
    padding: "0",
  },
  header: {
    borderBottom: `1px solid ${palette.border}`,
    padding: "20px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: palette.card,
  },
  logo: {
    fontSize: "18px",
    fontWeight: "700",
    letterSpacing: "0.15em",
    color: palette.accent,
    textTransform: "uppercase",
  },
  tabBar: {
    display: "flex",
    gap: "0",
    borderBottom: `1px solid ${palette.border}`,
    background: palette.card,
    padding: "0 32px",
  },
  tab: (active) => ({
    padding: "14px 24px",
    cursor: "pointer",
    fontSize: "12px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    fontWeight: active ? "700" : "400",
    color: active ? palette.accent : palette.muted,
    borderBottom: active ? `2px solid ${palette.accent}` : "2px solid transparent",
    background: "transparent",
    border: "none",
    outline: "none",
    transition: "color 0.2s",
    fontFamily: "inherit",
  }),
  main: {
    padding: "40px 32px",
    maxWidth: "720px",
    margin: "0 auto",
  },
  card: {
    background: palette.card,
    border: `1px solid ${palette.border}`,
    borderRadius: "4px",
    padding: "28px",
    marginBottom: "20px",
  },
  sectionTitle: {
    fontSize: "11px",
    letterSpacing: "0.2em",
    textTransform: "uppercase",
    color: palette.muted,
    marginBottom: "20px",
    fontWeight: "600",
  },
  questionText: {
    fontSize: "20px",
    fontWeight: "700",
    marginBottom: "24px",
    lineHeight: "1.4",
    color: palette.text,
  },
  optionBtn: (selected) => ({
    display: "flex",
    alignItems: "center",
    gap: "12px",
    width: "100%",
    padding: "14px 18px",
    marginBottom: "10px",
    background: selected ? "rgba(232,255,71,0.08)" : "transparent",
    border: `1px solid ${selected ? palette.accent : palette.border}`,
    borderRadius: "3px",
    color: selected ? palette.accent : palette.text,
    cursor: "pointer",
    fontSize: "14px",
    fontFamily: "inherit",
    letterSpacing: "0.03em",
    transition: "all 0.15s",
    textAlign: "left",
  }),
  dot: (selected) => ({
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    border: `2px solid ${selected ? palette.accent : palette.muted}`,
    background: selected ? palette.accent : "transparent",
    flexShrink: 0,
    transition: "all 0.15s",
  }),
  submitBtn: {
    marginTop: "20px",
    padding: "14px 32px",
    background: palette.accent,
    color: "#000",
    border: "none",
    borderRadius: "3px",
    fontSize: "12px",
    fontWeight: "700",
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.15s",
  },
  input: {
    width: "100%",
    background: "transparent",
    border: `1px solid ${palette.border}`,
    borderRadius: "3px",
    padding: "12px 16px",
    color: palette.text,
    fontSize: "14px",
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
    marginBottom: "12px",
  },
  select: {
    width: "100%",
    background: "#1c1c1c",
    border: `1px solid ${palette.border}`,
    borderRadius: "3px",
    padding: "12px 16px",
    color: palette.text,
    fontSize: "14px",
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
    marginBottom: "12px",
    cursor: "pointer",
  },
  label: {
    fontSize: "11px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: palette.muted,
    display: "block",
    marginBottom: "6px",
    fontWeight: "600",
  },
  removeBtn: {
    background: "transparent",
    border: "none",
    color: palette.danger,
    cursor: "pointer",
    fontSize: "18px",
    padding: "0 8px",
    fontFamily: "inherit",
    lineHeight: "1",
  },
  addBtn: {
    background: "transparent",
    border: `1px dashed ${palette.border}`,
    color: palette.muted,
    cursor: "pointer",
    padding: "10px 18px",
    fontSize: "12px",
    letterSpacing: "0.1em",
    fontFamily: "inherit",
    borderRadius: "3px",
    marginBottom: "20px",
    width: "100%",
    transition: "color 0.15s, border-color 0.15s",
  },
  resultBar: (pct, color) => ({
    height: "8px",
    background: color,
    borderRadius: "2px",
    width: `${pct}%`,
    transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
    minWidth: pct > 0 ? "4px" : "0",
  }),
  badge: (active) => ({
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    padding: "3px 10px",
    borderRadius: "2px",
    background: active ? "rgba(77,255,145,0.12)" : "rgba(255,77,77,0.12)",
    color: active ? palette.green : palette.danger,
    border: `1px solid ${active ? palette.green : palette.danger}`,
    fontWeight: "700",
  }),
  catChip: (color, active) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 14px",
    borderRadius: "999px",
    fontSize: "11px",
    letterSpacing: "0.08em",
    fontWeight: "700",
    border: `1px solid ${active ? color : palette.border}`,
    color: active ? color : palette.muted,
    background: active ? `${color}1a` : "transparent",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    transition: "all 0.15s",
  }),
  catDot: (color) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: color,
    flexShrink: 0,
  }),
  numBadge: (color) => ({
    fontSize: "10px",
    fontWeight: "800",
    color: color,
    opacity: 0.85,
  }),
  backLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    background: "transparent",
    border: "none",
    color: palette.muted,
    cursor: "pointer",
    fontSize: "12px",
    fontFamily: "inherit",
    letterSpacing: "0.08em",
    padding: "0",
    marginBottom: "20px",
  },
  roomHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "6px",
  },
  commentCard: {
    background: palette.card,
    border: `1px solid ${palette.border}`,
    borderRadius: "4px",
    padding: "16px 18px",
    marginBottom: "10px",
  },
  commentMeta: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "8px",
  },
  avatar: (color) => ({
    width: "26px",
    height: "26px",
    borderRadius: "50%",
    background: color,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "11px",
    fontWeight: "800",
    color: "#000",
    flexShrink: 0,
  }),
  commentAuthor: {
    fontSize: "12px",
    fontWeight: "700",
    color: palette.text,
  },
  commentTime: {
    fontSize: "11px",
    color: palette.muted,
  },
  commentBody: {
    fontSize: "14px",
    color: palette.text,
    lineHeight: "1.6",
    marginBottom: "10px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  commentActions: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  },
  actionBtn: (active) => ({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    background: "transparent",
    border: "none",
    color: active ? palette.accent : palette.muted,
    cursor: "pointer",
    fontSize: "12px",
    fontFamily: "inherit",
    padding: "0",
    fontWeight: active ? "700" : "400",
  }),
  replyBox: {
    marginLeft: "20px",
    marginTop: "10px",
    paddingLeft: "14px",
    borderLeft: `2px solid ${palette.border}`,
  },
  commentInputBar: {
    display: "flex",
    gap: "10px",
    alignItems: "flex-end",
  },
  textarea: {
    width: "100%",
    background: "transparent",
    border: `1px solid ${palette.border}`,
    borderRadius: "3px",
    padding: "12px 16px",
    color: palette.text,
    fontSize: "14px",
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
    resize: "vertical",
    minHeight: "44px",
  },
};

function CategoryFilterBar({ categories, selected, onSelect }) {
  return (
    <div style={{ display: "flex", gap: "8px", overflowX: "auto", marginBottom: "24px", paddingBottom: "4px" }}>
      <button style={styles.catChip(palette.text, selected === null)} onClick={() => onSelect(null)}>
        すべて
      </button>
      {categories.map((c) => (
        <button key={c.id} style={styles.catChip(c.color, selected === c.id)} onClick={() => onSelect(c.id)}>
          <span style={styles.catDot(c.color)} />
          <span style={styles.numBadge(selected === c.id ? c.color : palette.muted)}>#{c.number}</span>
          {c.name}
        </button>
      ))}
    </div>
  );
}

function CategoryTag({ category, onOpenRoom }) {
  if (!category) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpenRoom && onOpenRoom(category.id); }}
      style={{
        ...styles.catChip(category.color, true),
        padding: "4px 10px",
        fontSize: "10px",
        marginBottom: "12px",
        cursor: onOpenRoom ? "pointer" : "default",
      }}
      title={onOpenRoom ? "議論ルームを開く" : undefined}
    >
      <span style={styles.catDot(category.color)} />
      <span style={styles.numBadge(category.color)}>#{category.number}</span>
      {category.name}
      {onOpenRoom && <span style={{ opacity: 0.6, marginLeft: "2px" }}>💬</span>}
    </button>
  );
}

// ─── DISCUSSION ROOM ───────────────────────────────────────────
const GUEST_NAME = "ゲスト";

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "今";
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  return `${day}日前`;
}

function initials(name) {
  return (name || "?").trim().slice(0, 1).toUpperCase();
}

function CommentItem({ comment, color, onReply, onLike, onEvaluate, data, session, onRequestLogin, iCommentedHere, mainTalkerIds, depth = 0 }) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");

  const submitReply = async () => {
    if (!replyText.trim()) return;
    const ok = await onReply(comment.id, replyText.trim());
    if (ok) {
      setReplyText("");
      setReplying(false);
    }
  };

  const clickReply = () => {
    if (!session) {
      onRequestLogin && onRequestLogin();
      return;
    }
    setReplying((r) => !r);
  };

  const isMine = session && comment.userId === session.user.id;
  const isMainTalker = comment.userId && mainTalkerIds && mainTalkerIds.has(comment.userId);
  const insightCount = commentEvalCount(data, comment.id, "insight");
  const deltaCount = commentEvalCount(data, comment.id, "delta");
  const ratedInsight = session && hasRatedComment(data, comment.id, session.user.id, "insight");
  const ratedDelta = session && hasRatedComment(data, comment.id, session.user.id, "delta");
  const canEvalInsight = session && !isMine && iCommentedHere && !ratedInsight;
  const canEvalDelta = session && !isMine && iCommentedHere && !ratedDelta;

  return (
    <div>
      <div style={styles.commentCard}>
        <div style={styles.commentMeta}>
          {comment.avatarUrl ? (
            <img src={comment.avatarUrl} alt="" style={{ ...styles.avatar(color), objectFit: "cover", padding: 0 }} />
          ) : (
            <span style={styles.avatar(color)}>{initials(comment.author)}</span>
          )}
          <span style={styles.commentAuthor}>{comment.author}</span>
          {isMainTalker && (
            <span style={{ fontSize: "10px", fontWeight: "700", color: "#000", background: palette.accent, padding: "2px 6px", borderRadius: "10px" }}>
              🎤 メイントーカー
            </span>
          )}
          <span style={styles.commentTime}>{timeAgo(comment.ts)}</span>
        </div>
        <div style={styles.commentBody}>{comment.text}</div>
        <div style={styles.commentActions}>
          <button style={styles.actionBtn(comment.liked)} onClick={() => onLike(comment.id, comment.likes, comment.liked)}>
            {comment.liked ? "❤" : "♡"} {comment.likes}
          </button>
          <button
            style={{ ...styles.actionBtn(ratedInsight), opacity: canEvalInsight || ratedInsight ? 1 : 0.4, cursor: canEvalInsight ? "pointer" : "default" }}
            onClick={() => canEvalInsight && onEvaluate(comment.id, "insight")}
            disabled={!canEvalInsight}
          >
            💡 鋭い視点 {insightCount}
          </button>
          <button
            style={{ ...styles.actionBtn(ratedDelta), opacity: canEvalDelta || ratedDelta ? 1 : 0.4, cursor: canEvalDelta ? "pointer" : "default" }}
            onClick={() => canEvalDelta && onEvaluate(comment.id, "delta")}
            disabled={!canEvalDelta}
          >
            Δ 意見が変わった {deltaCount}
          </button>
          <button style={styles.actionBtn(false)} onClick={clickReply}>
            ↩ 返信
          </button>
          {comment.replies && comment.replies.length > 0 && (
            <span style={{ fontSize: "11px", color: palette.muted }}>{comment.replies.length}件の返信</span>
          )}
        </div>

        {replying && (
          <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
            <input
              style={{ ...styles.input, marginBottom: 0, flex: 1 }}
              placeholder={`${comment.author} に返信...`}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitReply()}
              autoFocus
            />
            <button style={{ ...styles.submitBtn, marginTop: 0, padding: "12px 20px" }} onClick={submitReply}>送信</button>
          </div>
        )}
      </div>

      {comment.replies && comment.replies.length > 0 && (
        <div style={styles.replyBox}>
          {comment.replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              color={color}
              onReply={onReply}
              onLike={onLike}
              onEvaluate={onEvaluate}
              data={data}
              session={session}
              onRequestLogin={onRequestLogin}
              iCommentedHere={iCommentedHere}
              mainTalkerIds={mainTalkerIds}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DiscussionRoom({ data, refresh, categoryId, onBack, session, displayName, avatarUrl, onRequestLogin }) {
  const category = data.categories.find((c) => c.id === categoryId);
  const [text, setText] = useState("");
  const [postError, setPostError] = useState("");
  const relatedPolls = data.polls.filter((p) => p.categoryId === categoryId);

  if (!category) {
    return (
      <div style={styles.main}>
        <button style={styles.backLink} onClick={onBack}>← 戻る</button>
        <div style={{ color: palette.muted }}>このテーマは見つかりません。</div>
      </div>
    );
  }

  const postComment = async () => {
    if (!session || !text.trim()) return;
    setPostError("");
    const { error } = await supabase.from("comments").insert({ category_id: categoryId, author: displayName, avatar_url: avatarUrl || null, user_id: session.user.id, text: text.trim(), likes: 0 });
    if (error) {
      setPostError("投稿に失敗しました： " + error.message);
      return;
    }
    setText("");
    await refresh();
  };

  const handleReply = async (parentId, replyText) => {
    if (!session) return false;
    const { error } = await supabase.from("comments").insert({ category_id: categoryId, parent_id: parentId, author: displayName, avatar_url: avatarUrl || null, user_id: session.user.id, text: replyText, likes: 0 });
    if (error) {
      alert("返信の投稿に失敗しました： " + error.message);
      return false;
    }
    await refresh();
    return true;
  };

  const handleLike = async (id, currentLikes, alreadyLiked) => {
    const likedIds = getLikedIds();
    const newLikes = alreadyLiked ? Math.max(0, currentLikes - 1) : currentLikes + 1;
    const { error } = await supabase.from("comments").update({ likes: newLikes }).eq("id", id);
    if (error) {
      alert("いいねに失敗しました： " + error.message);
      return;
    }
    if (alreadyLiked) likedIds.delete(id);
    else likedIds.add(id);
    saveLikedIds(likedIds);
    await refresh();
  };

  const handleEvaluate = async (commentId, kind) => {
    if (!session) return;
    const { error } = await supabase.from("comment_evaluations").insert({ comment_id: commentId, rater_id: session.user.id, kind });
    if (error) {
      alert("評価に失敗しました： " + error.message);
      return;
    }
    await refresh();
  };

  const comments = category.comments || [];
  const iCommentedHere = !!(session && flattenComments(comments).some((c) => c.userId === session.user.id));
  const countAll = (list) => list.reduce((sum, c) => sum + 1 + countAll(c.replies || []), 0);
  const talkersForCategory = (data.mainTalkers || []).filter((t) => t.categoryId === categoryId);
  const mainTalkerIds = new Set(talkersForCategory.map((t) => t.userId));

  return (
    <div style={styles.main}>
      <button style={styles.backLink} onClick={onBack}>← 投票一覧に戻る</button>

      <div style={styles.roomHeader}>
        <span style={styles.catDot(category.color)} />
        <span style={{ ...styles.numBadge(category.color), fontSize: "13px" }}>#{category.number}</span>
        <span style={{ fontSize: "20px", fontWeight: "800" }}>{category.name}</span>
      </div>

      {talkersForCategory.length > 0 && (
        <div style={{ ...styles.card, marginBottom: "20px", background: "rgba(232,255,71,0.06)", border: `1px solid ${palette.accent}` }}>
          <div style={{ fontSize: "11px", color: palette.accent, letterSpacing: "0.08em", marginBottom: "10px" }}>🎤 このテーマのメイントーカー</div>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
            {talkersForCategory.map((t) => (
              <div key={t.userId} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div
                  style={{
                    width: "32px", height: "32px", borderRadius: "50%", overflow: "hidden", background: palette.border,
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "700", color: palette.accent, flexShrink: 0,
                  }}
                >
                  {getProfileAvatar(data, t.userId) ? (
                    <img src={getProfileAvatar(data, t.userId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    initials(getProfileName(data, t.userId))
                  )}
                </div>
                <span style={{ fontSize: "13px", fontWeight: "700" }}>{getProfileName(data, t.userId)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {relatedPolls.length > 0 && (
        <div style={{ marginBottom: "28px" }}>
          <div style={{ ...styles.sectionTitle, marginBottom: "16px" }}>このテーマの質問 — {relatedPolls.length}件</div>
          {relatedPolls.map((poll) => (
            <PollCard key={poll.id} poll={poll} data={data} refresh={refresh} onOpenRoom={onOpenRoom} session={session} onRequestLogin={onRequestLogin} />
          ))}
        </div>
      )}

      <div style={{ ...styles.sectionTitle, marginBottom: "12px" }}>
        議論ルーム · {countAll(comments)}件のコメント
      </div>
      <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "24px", lineHeight: 1.6 }}>
        💡 鋭い視点・Δ（意見が変わった）は、このスレッドに自分もコメントした人だけが他の人の発言に付けられます。自分のコメントには付けられません。
      </div>

      {session ? (
        <div style={{ ...styles.card, marginBottom: "24px" }}>
          <label style={styles.label}>このテーマについて投稿する</label>
          <div style={styles.commentInputBar}>
            <textarea
              style={styles.textarea}
              placeholder={`#${category.number} ${category.name} について意見を書く...`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
            />
            <button style={{ ...styles.submitBtn, marginTop: 0, padding: "12px 24px" }} onClick={postComment}>投稿</button>
          </div>
          {postError && <div style={{ color: palette.danger, fontSize: "12px", marginTop: "8px" }}>{postError}</div>}
        </div>
      ) : (
        <div style={{ marginBottom: "24px" }}>
          <LoginPrompt message="コメントするにはログインが必要です" onRequestLogin={onRequestLogin} />
        </div>
      )}

      {comments.length === 0 ? (
        <div style={{ ...styles.card, textAlign: "center", padding: "50px 28px" }}>
          <div style={{ color: palette.muted, fontSize: "14px" }}>まだコメントがありません。最初の投稿をしてみましょう。</div>
        </div>
      ) : (
        comments.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            color={category.color}
            onReply={handleReply}
            onLike={handleLike}
            onEvaluate={handleEvaluate}
            data={data}
            session={session}
            onRequestLogin={onRequestLogin}
            iCommentedHere={iCommentedHere}
            mainTalkerIds={mainTalkerIds}
          />
        ))
      )}
    </div>
  );
}


// ─── ログイン／新規登録フォーム ────────────────────────────────
function AuthForm({ onSuccess }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError("");
    if (!email.trim() || !password.trim() || (mode === "signup" && !displayName.trim())) {
      setError("すべての項目を入力してください");
      return;
    }
    setLoading(true);
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      if (data.user) {
        await supabase.from("profiles").insert({ id: data.user.id, display_name: displayName.trim() });
      }
      setLoading(false);
      onSuccess && onSuccess();
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      setLoading(false);
      if (error) {
        setError(error.message);
        return;
      }
      onSuccess && onSuccess();
    }
  };

  return (
    <div style={{ ...styles.card, maxWidth: "360px", margin: "0 auto 24px" }}>
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        <button style={styles.tab(mode === "login")} onClick={() => { setMode("login"); setError(""); }}>ログイン</button>
        <button style={styles.tab(mode === "signup")} onClick={() => { setMode("signup"); setError(""); }}>新規登録</button>
      </div>
      {mode === "signup" && (
        <input
          style={styles.input}
          placeholder="表示名（コメントなどに表示されます）"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      )}
      <input
        style={styles.input}
        type="email"
        placeholder="メールアドレス"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        style={styles.input}
        type="password"
        placeholder="パスワード（6文字以上）"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {error && <div style={{ color: palette.danger, fontSize: "12px", marginBottom: "12px" }}>{error}</div>}
      <button style={{ ...styles.submitBtn, opacity: loading ? 0.6 : 1 }} onClick={submit} disabled={loading}>
        {loading ? "処理中..." : mode === "signup" ? "登録する" : "ログイン"}
      </button>
    </div>
  );
}

function LoginPrompt({ message, onRequestLogin }) {
  return (
    <div style={{ ...styles.card, textAlign: "center", padding: "32px 20px" }}>
      <div style={{ color: palette.muted, fontSize: "13px", marginBottom: "16px" }}>{message}</div>
      <button style={styles.submitBtn} onClick={onRequestLogin}>ログイン / 新規登録</button>
    </div>
  );
}

// ─── フィード（断片的なつぶやきが流れるTwitter風ページ） ───────────
// ─── 議論 一覧（投票の有無に関わらず、全テーマを横断して見られる入り口） ──
function DiscussionBrowseScreen({ data, onOpenRoom }) {
  const countAllComments = (cat) => {
    const sum = (list) => (list || []).reduce((s, c) => s + 1 + sum(c.replies), 0);
    return sum(cat.comments);
  };

  return (
    <div style={styles.main}>
      <div style={styles.sectionTitle}>議論 — {data.categories.length}件のテーマ</div>
      <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "24px", lineHeight: 1.6 }}>
        投票の有無に関わらず、すべてのテーマの議論ルームがここから見られます。選択肢のないテーマで自由に意見交換できます。
      </div>

      {data.categories.length === 0 ? (
        <div style={{ ...styles.card, textAlign: "center", padding: "60px 28px" }}>
          <div style={{ color: palette.muted, fontSize: "14px" }}>まだテーマがありません。</div>
        </div>
      ) : (
        data.categories.map((cat) => {
          const pollCount = data.polls.filter((p) => p.categoryId === cat.id).length;
          const commentCount = countAllComments(cat);
          const talkerCount = (data.mainTalkers || []).filter((t) => t.categoryId === cat.id).length;
          return (
            <button
              key={cat.id}
              onClick={() => onOpenRoom(cat.id)}
              style={{ ...styles.card, display: "block", width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <span style={styles.catDot(cat.color)} />
                <span style={{ ...styles.numBadge(cat.color), fontSize: "12px" }}>#{cat.number}</span>
                <span style={{ fontSize: "16px", fontWeight: "700", color: palette.text }}>{cat.name}</span>
                {talkerCount > 0 && (
                  <span style={{ fontSize: "10px", fontWeight: "700", color: "#000", background: palette.accent, padding: "2px 6px", borderRadius: "10px" }}>
                    🎤 {talkerCount}
                  </span>
                )}
              </div>
              <div style={{ fontSize: "12px", color: palette.muted }}>
                💬 {commentCount}件のコメント{pollCount > 0 ? ` · 関連する質問 ${pollCount}件` : " · 自由議論のみ"}
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

function FeedScreen({ data, refresh, session, displayName, avatarUrl, onRequestLogin }) {
  const [text, setText] = useState("");
  const [postError, setPostError] = useState("");
  const posts = data.posts || [];

  const postFeed = async () => {
    if (!session || !text.trim()) return;
    setPostError("");
    const { error } = await supabase.from("posts").insert({ author: displayName, avatar_url: avatarUrl || null, text: text.trim(), likes: 0 });
    if (error) {
      setPostError("投稿に失敗しました： " + error.message);
      return;
    }
    setText("");
    await refresh();
  };

  const handleLike = async (id, currentLikes, alreadyLiked) => {
    const likedIds = getLikedIds();
    const newLikes = alreadyLiked ? Math.max(0, currentLikes - 1) : currentLikes + 1;
    const { error } = await supabase.from("posts").update({ likes: newLikes }).eq("id", id);
    if (error) {
      alert("いいねに失敗しました： " + error.message);
      return;
    }
    if (alreadyLiked) likedIds.delete(id);
    else likedIds.add(id);
    saveLikedIds(likedIds);
    await refresh();
  };

  return (
    <div style={styles.main}>
      <div style={styles.sectionTitle}>フィード — {posts.length}件のつぶやき</div>

      {session ? (
        <div style={{ ...styles.card, marginBottom: "24px" }}>
          <div style={styles.commentInputBar}>
            <textarea
              style={styles.textarea}
              placeholder="いまどうしてる？"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 280))}
              rows={2}
            />
            <button style={{ ...styles.submitBtn, marginTop: 0, padding: "12px 24px" }} onClick={postFeed}>投稿</button>
          </div>
          <div style={{ fontSize: "11px", color: palette.muted, marginTop: "6px", textAlign: "right" }}>{text.length}/280</div>
          {postError && <div style={{ color: palette.danger, fontSize: "12px", marginTop: "8px" }}>{postError}</div>}
        </div>
      ) : (
        <div style={{ marginBottom: "24px" }}>
          <LoginPrompt message="投稿するにはログインが必要です" onRequestLogin={onRequestLogin} />
        </div>
      )}

      {posts.length === 0 ? (
        <div style={{ ...styles.card, textAlign: "center", padding: "50px 28px" }}>
          <div style={{ color: palette.muted, fontSize: "14px" }}>まだ投稿がありません。最初の一言を投稿してみましょう。</div>
        </div>
      ) : (
        posts.map((p) => (
          <div key={p.id} style={styles.commentCard}>
            <div style={styles.commentMeta}>
              {p.avatarUrl ? (
                <img src={p.avatarUrl} alt="" style={{ ...styles.avatar(palette.accent), objectFit: "cover" }} />
              ) : (
                <span style={styles.avatar(palette.accent)}>{initials(p.author)}</span>
              )}
              <span style={styles.commentAuthor}>{p.author}</span>
              <span style={styles.commentTime}>{timeAgo(p.ts)}</span>
            </div>
            <div style={styles.commentBody}>{p.text}</div>
            <div style={styles.commentActions}>
              <button style={styles.actionBtn(p.liked)} onClick={() => handleLike(p.id, p.likes, p.liked)}>
                {p.liked ? "❤" : "♡"} {p.likes}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── 質問1問分の表示・投票ロジック（投票画面・議論ルームの両方から使う） ──
function PollCard({ poll, data, refresh, onOpenRoom, session, onRequestLogin }) {
  const voterId = session ? session.user.id : null;
  const myRecord = (data.voteRecords || []).find((r) => r.pollId === poll.id && r.voterId === voterId);

  const [selections, setSelections] = useState(() => (myRecord ? myRecord.selectedOptions : []));
  const [voted, setVoted] = useState(() => !!myRecord);
  const [reason, setReason] = useState("");
  const [editingReason, setEditingReason] = useState(false);
  const [editText, setEditText] = useState("");

  const cat = data.categories.find((c) => c.id === poll.categoryId) || null;
  const didVote = voted;
  const sel = selections;
  const total = poll.votes.reduce((a, b) => a + b, 0) + (didVote ? sel.length : 0);

  const toggle = (idx, multiple) => {
    if (voted) return;
    setSelections((cur) => {
      if (multiple) {
        return cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx];
      } else {
        return cur.includes(idx) ? [] : [idx];
      }
    });
  };

  const submitVote = async () => {
    if (!session) return;
    if (sel.length === 0) return;
    const { error } = await supabase.from("vote_records").insert({ poll_id: poll.id, voter_id: voterId, selected_options: sel, reason: reason.trim() || null });
    if (error) {
      alert("投票に失敗しました： " + error.message);
      return;
    }
    setVoted(true);
    await refresh();
  };

  const handleInsight = async (record) => {
    if (!session) return;
    const { error } = await supabase.from("insight_votes").insert({ vote_record_id: record.id, rater_id: session.user.id });
    if (error) {
      alert("評価に失敗しました： " + error.message);
      return;
    }
    await refresh();
  };

  const updateReason = async (record, newReason) => {
    const { error } = await supabase.from("vote_records").update({ reason: newReason || null }).eq("id", record.id);
    if (error) {
      alert("理由の更新に失敗しました： " + error.message);
      return;
    }
    setEditingReason(false);
    await refresh();
  };

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <CategoryTag category={cat} onOpenRoom={onOpenRoom} />
        <div style={{ ...styles.sectionTitle, marginBottom: "12px" }}>
          {poll.multiple ? "複数選択可" : "単一選択"}
        </div>
      </div>
      <div style={styles.questionText}>{poll.question}</div>
      <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "16px", marginTop: "-8px" }}>
        🏆 正解 +{poll.correctPoints}pt ／ 不正解 -{poll.incorrectPoints}pt
      </div>

      {didVote ? (
        <div>
          <div style={{ ...styles.sectionTitle, marginBottom: "16px", color: palette.green }}>
            ✓ 投票完了 — 結果
          </div>

          {!poll.resolved && myRecord && (() => {
            const editable = canEditReason(poll);
            return (
              <div style={{ marginBottom: "16px", padding: "12px 14px", background: "#1a1a1a", borderRadius: "3px", border: `1px solid ${palette.border}` }}>
                <div style={{ fontSize: "11px", color: editable ? palette.muted : palette.danger, marginBottom: "8px" }}>
                  あなたの理由 ・ {editable
                    ? `💬 ${poll.reasonLockAt ? `${formatDateTime(poll.reasonLockAt)}まで編集できます` : "結果確定までは自由に編集できます。確定後は変更できなくなるのでご注意ください。"}`
                    : "🔒 変更期限を過ぎました。これ以降は編集できません。"}
                </div>
                {editingReason && editable ? (
                  <div>
                    <textarea
                      style={{ ...styles.textarea, width: "100%", boxSizing: "border-box" }}
                      rows={2}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      autoFocus
                    />
                    <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                      <button style={{ ...styles.submitBtn, marginTop: 0, padding: "8px 16px", fontSize: "11px" }} onClick={() => updateReason(myRecord, editText.trim())}>
                        保存
                      </button>
                      <button
                        style={{ ...styles.submitBtn, marginTop: 0, padding: "8px 16px", fontSize: "11px", background: "transparent", color: palette.muted, border: `1px solid ${palette.border}` }}
                        onClick={() => setEditingReason(false)}
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: "13px", marginBottom: "8px" }}>
                      {myRecord.reason ? myRecord.reason : <span style={{ color: palette.muted }}>（理由はまだ書かれていません）</span>}
                    </div>
                    {editable && (
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          style={{ ...styles.submitBtn, marginTop: 0, padding: "8px 16px", fontSize: "11px" }}
                          onClick={() => { setEditingReason(true); setEditText(myRecord.reason || ""); }}
                        >
                          {myRecord.reason ? "編集" : "理由を追加"}
                        </button>
                        {myRecord.reason && (
                          <button
                            style={{ ...styles.submitBtn, marginTop: 0, padding: "8px 16px", fontSize: "11px", background: "transparent", color: palette.danger, border: `1px solid ${palette.danger}` }}
                            onClick={() => updateReason(myRecord, null)}
                          >
                            削除
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {poll.resolved && (() => {
            const correct = isCorrectSelection(poll, sel);
            const pts = pointsForRecord(poll, sel);
            return (
              <div
                style={{
                  marginBottom: "16px",
                  padding: "10px 14px",
                  borderRadius: "3px",
                  fontSize: "12px",
                  fontWeight: "700",
                  letterSpacing: "0.04em",
                  background: correct ? "rgba(77,255,145,0.1)" : "rgba(255,77,77,0.1)",
                  color: correct ? palette.green : palette.danger,
                  border: `1px solid ${correct ? palette.green : palette.danger}`,
                }}
              >
                {correct ? "🎯 的中！あなたの予測は正解でした" : "✗ 不正解でした"}　{pts >= 0 ? `+${pts}` : pts}pt
              </div>
            );
          })()}

          {poll.options.map((opt, i) => {
            const v = poll.votes[i] + (sel.includes(i) ? 1 : 0);
            const pct = total > 0 ? Math.round((v / total) * 100) : 0;
            const isSelected = sel.includes(i);
            const isCorrectOpt = poll.resolved && (poll.correctOptions || []).includes(i);
            const barColor = isCorrectOpt ? palette.green : isSelected ? palette.accent : palette.muted;
            return (
              <div key={i} style={{ marginBottom: "14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px", fontSize: "13px" }}>
                  <span style={{ color: isCorrectOpt ? palette.green : isSelected ? palette.accent : palette.text }}>
                    {isCorrectOpt && "🎯 "}{opt}{isSelected && <span style={{ color: palette.muted }}> （あなたの回答）</span>}
                  </span>
                  <span style={{ color: palette.muted }}>{pct}% ({v}票)</span>
                </div>
                <div style={{ background: palette.border, borderRadius: "2px", height: "8px" }}>
                  <div style={styles.resultBar(pct, barColor)} />
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: "12px", color: palette.muted, marginTop: "12px" }}>
            合計 {total} 票{!poll.resolved && " · 正解発表をお待ちください"}
          </div>

          {poll.resolved && (() => {
            const reasonRecords = (data.voteRecords || []).filter((r) => r.pollId === poll.id && r.reason && r.reason.trim());
            if (reasonRecords.length === 0) return null;
            const periodOpen = isInsightPeriodOpen(poll);
            return (
              <div style={{ marginTop: "20px", borderTop: `1px solid ${palette.border}`, paddingTop: "16px" }}>
                <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginBottom: "12px" }}>
                  💡 みんなの理由（{reasonRecords.length}件）{!periodOpen && " · 評価期間は終了しました"}
                </div>
                {reasonRecords.map((r) => {
                  const isMine = session && r.voterId === session.user.id;
                  const iVotedThisPoll = session && (data.voteRecords || []).some((vr) => vr.pollId === poll.id && vr.voterId === session.user.id);
                  const alreadyRated = session && hasRatedInsight(data, r.id, session.user.id);
                  const count = insightCountFor(data, r.id);
                  const canRate = session && !isMine && iVotedThisPoll && periodOpen && !alreadyRated;
                  return (
                    <div key={r.id} style={{ ...styles.commentCard, marginBottom: "10px" }}>
                      <div style={styles.commentMeta}>
                        {getProfileAvatar(data, r.voterId) ? (
                          <img src={getProfileAvatar(data, r.voterId)} alt="" style={{ ...styles.avatar(palette.accent), objectFit: "cover" }} />
                        ) : (
                          <span style={styles.avatar(palette.accent)}>{initials(getProfileName(data, r.voterId))}</span>
                        )}
                        <span style={styles.commentAuthor}>{getProfileName(data, r.voterId)}</span>
                        <span style={{ fontSize: "11px", color: palette.muted }}>{r.selectedOptions.map((i) => poll.options[i]).join("、")}を選択</span>
                        {isMine && <span style={{ fontSize: "11px", color: palette.muted }}>・🔒 確定済み（あなたの理由）</span>}
                      </div>
                      <div style={styles.commentBody}>{r.reason}</div>
                      <div style={styles.commentActions}>
                        <button
                          style={{ ...styles.actionBtn(alreadyRated), opacity: canRate || alreadyRated ? 1 : 0.4, cursor: canRate ? "pointer" : "default" }}
                          onClick={() => canRate && handleInsight(r)}
                          disabled={!canRate}
                        >
                          💡 鋭い視点 {count}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : !session ? (
        <LoginPrompt message="投票するにはログインが必要です" onRequestLogin={onRequestLogin} />
      ) : (
        <div>
          {poll.options.map((opt, i) => (
            <button key={i} style={styles.optionBtn(sel.includes(i))} onClick={() => toggle(i, poll.multiple)}>
              <span style={styles.dot(sel.includes(i))} />
              {opt}
            </button>
          ))}
          <textarea
            style={{ ...styles.textarea, width: "100%", boxSizing: "border-box", marginTop: "8px" }}
            rows={2}
            placeholder="そう思う理由を書く（任意・結果確定後に他の投票者に公開されます）"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            style={{ ...styles.submitBtn, opacity: sel.length === 0 ? 0.4 : 1, cursor: sel.length === 0 ? "not-allowed" : "pointer" }}
            onClick={submitVote}
            disabled={sel.length === 0}
          >
            投票する
          </button>
        </div>
      )}
    </div>
  );
}

function VoteScreen({ data, refresh, onOpenRoom, session, onRequestLogin }) {
  const [filterCat, setFilterCat] = useState(null);
  const activePolls = data.polls.filter((p) => isPollOpen(p) && (filterCat === null || p.categoryId === filterCat));

  return (
    <div style={styles.main}>
      {data.categories.length > 0 && (
        <CategoryFilterBar categories={data.categories} selected={filterCat} onSelect={setFilterCat} />
      )}

      <div style={styles.sectionTitle}>公開中の質問 — {activePolls.length}件</div>

      {activePolls.length === 0 ? (
        <div style={{ ...styles.card, textAlign: "center", padding: "60px 28px" }}>
          <div style={{ fontSize: "32px", marginBottom: "16px" }}>📭</div>
          <div style={{ color: palette.muted, fontSize: "14px", letterSpacing: "0.08em" }}>
            このテーマに公開中の質問はありません
          </div>
        </div>
      ) : (
        activePolls.map((poll) => (
          <PollCard key={poll.id} poll={poll} data={data} refresh={refresh} onOpenRoom={onOpenRoom} session={session} onRequestLogin={onRequestLogin} />
        ))
      )}
    </div>
  );
}

// ─── CATEGORY MANAGER ──────────────────────────────────────────
function CategoryManager({ data, refresh, onOpenRoom }) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [talkerPanelId, setTalkerPanelId] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState("");

  const addCategory = async () => {
    if (!newName.trim()) return;
    const usedColors = data.categories.map((c) => c.color);
    const color = CATEGORY_COLORS.find((c) => !usedColors.includes(c)) || CATEGORY_COLORS[data.categories.length % CATEGORY_COLORS.length];
    const number = data.nextCategoryNumber || data.categories.length + 1;
    setNewName("");
    await supabase.from("categories").insert({ name: newName.trim(), color, number });
    await refresh();
  };

  const startEdit = (cat) => { setEditingId(cat.id); setEditName(cat.name); };

  const saveEdit = async () => {
    if (!editName.trim()) return;
    await supabase.from("categories").update({ name: editName.trim() }).eq("id", editingId);
    setEditingId(null);
    await refresh();
  };

  const deleteCategory = async (id) => {
    await supabase.from("polls").update({ category_id: null }).eq("category_id", id);
    await supabase.from("categories").delete().eq("id", id);
    await refresh();
  };

  const addTalker = async (categoryId) => {
    if (!selectedUserId) return;
    await supabase.from("main_talkers").insert({ category_id: categoryId, user_id: selectedUserId });
    setSelectedUserId("");
    await refresh();
  };

  const removeTalker = async (categoryId, userId) => {
    await supabase.from("main_talkers").delete().eq("category_id", categoryId).eq("user_id", userId);
    await refresh();
  };

  const countForCategory = (id) => data.polls.filter((p) => p.categoryId === id).length;
  const countComments = (cat) => {
    const sum = (list) => (list || []).reduce((s, c) => s + 1 + sum(c.replies), 0);
    return sum(cat.comments);
  };

  return (
    <div style={{ ...styles.card, marginBottom: "28px" }}>
      <div style={styles.sectionTitle}>テーマ（カテゴリ）管理</div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        <input
          style={{ ...styles.input, marginBottom: 0, flex: 1 }}
          placeholder="新しいテーマ名（例：政治、グルメ...）"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCategory()}
        />
        <button style={{ ...styles.submitBtn, marginTop: 0, padding: "12px 24px" }} onClick={addCategory}>追加</button>
      </div>

      {data.categories.length === 0 ? (
        <div style={{ color: palette.muted, fontSize: "13px" }}>テーマがまだありません。上で追加してください。</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {data.categories.map((cat) => {
            const talkers = (data.mainTalkers || []).filter((t) => t.categoryId === cat.id);
            const assignedIds = talkers.map((t) => t.userId);
            const availableProfiles = (data.profiles || []).filter((p) => !assignedIds.includes(p.id));
            return (
              <div key={cat.id}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: "#1a1a1a", borderRadius: "3px", border: `1px solid ${palette.border}` }}>
                  <span style={styles.catDot(cat.color)} />
                  <span style={{ ...styles.numBadge(cat.color), fontSize: "11px" }}>#{cat.number}</span>
                  {editingId === cat.id ? (
                    <input
                      style={{ ...styles.input, marginBottom: 0, flex: 1, padding: "6px 10px" }}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                      autoFocus
                    />
                  ) : (
                    <span style={{ flex: 1, fontSize: "13px", fontWeight: "600" }}>{cat.name}</span>
                  )}
                  <span style={{ fontSize: "11px", color: palette.muted, marginRight: "4px" }}>{countForCategory(cat.id)}件の質問</span>
                  {onOpenRoom && (
                    <button style={{ ...styles.removeBtn, color: palette.muted, fontSize: "13px" }} onClick={() => onOpenRoom(cat.id)}>
                      💬 {countComments(cat)}
                    </button>
                  )}
                  <button
                    style={{ ...styles.removeBtn, color: talkerPanelId === cat.id ? palette.accent : palette.muted, fontSize: "13px" }}
                    onClick={() => setTalkerPanelId(talkerPanelId === cat.id ? null : cat.id)}
                  >
                    🎤 {talkers.length}
                  </button>
                  {editingId === cat.id ? (
                    <button style={{ ...styles.removeBtn, color: palette.green, fontSize: "13px" }} onClick={saveEdit}>保存</button>
                  ) : (
                    <button style={{ ...styles.removeBtn, color: palette.muted, fontSize: "13px" }} onClick={() => startEdit(cat)}>編集</button>
                  )}
                  <button style={styles.removeBtn} onClick={() => deleteCategory(cat.id)}>×</button>
                </div>

                {talkerPanelId === cat.id && (
                  <div style={{ padding: "12px 14px", marginTop: "4px", background: "#161616", borderRadius: "3px", border: `1px solid ${palette.border}` }}>
                    <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "10px" }}>
                      🎤 「{cat.name}」のメイントーカー（複数人指定可）
                    </div>
                    {talkers.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
                        {talkers.map((t) => (
                          <span
                            key={t.userId}
                            style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "5px 10px", background: "rgba(232,255,71,0.12)", border: `1px solid ${palette.accent}`, borderRadius: "20px" }}
                          >
                            {getProfileName(data, t.userId)}
                            <button onClick={() => removeTalker(cat.id, t.userId)} style={{ background: "none", border: "none", color: palette.muted, cursor: "pointer", fontSize: "13px", padding: 0 }}>
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: "8px" }}>
                      <select
                        style={{ ...styles.input, marginBottom: 0, flex: 1 }}
                        value={selectedUserId}
                        onChange={(e) => setSelectedUserId(e.target.value)}
                      >
                        <option value="">ユーザーを選択...</option>
                        {availableProfiles.map((p) => (
                          <option key={p.id} value={p.id}>{p.display_name}</option>
                        ))}
                      </select>
                      <button style={{ ...styles.submitBtn, marginTop: 0 }} onClick={() => addTalker(cat.id)}>追加</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 管理画面の簡易パスワードゲート ───────────────────────────
function AdminGate({ onUnlock }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  const tryUnlock = () => {
    if (input === ADMIN_PASSWORD) {
      try { localStorage.setItem(ADMIN_UNLOCK_KEY, "true"); } catch {}
      onUnlock();
    } else {
      setError(true);
    }
  };

  return (
    <div style={styles.main}>
      <div style={{ ...styles.card, maxWidth: "340px", margin: "60px auto", textAlign: "center" }}>
        <div style={{ fontSize: "32px", marginBottom: "12px" }}>🔒</div>
        <div style={{ ...styles.sectionTitle, marginBottom: "16px" }}>管理画面パスワード</div>
        <input
          type="password"
          style={styles.input}
          placeholder="パスワードを入力"
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(false); }}
          onKeyDown={(e) => e.key === "Enter" && tryUnlock()}
          autoFocus
        />
        {error && (
          <div style={{ color: palette.danger, fontSize: "12px", marginBottom: "12px" }}>
            パスワードが違います
          </div>
        )}
        <button style={styles.submitBtn} onClick={tryUnlock}>開く</button>
      </div>
    </div>
  );
}

// ─── 全ユーザーの成績（管理者専用） ─────────────────────────────
function AdminLeaderboard({ data }) {
  const leaderboard = computeLeaderboard(data);

  return (
    <div style={{ ...styles.card, marginBottom: "28px" }}>
      <div style={styles.sectionTitle}>全ユーザーの成績</div>
      {leaderboard.length === 0 ? (
        <div style={{ color: palette.muted, fontSize: "13px" }}>まだ正解が確定した質問への投票がありません。</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "0 12px", fontSize: "10px", color: palette.muted, letterSpacing: "0.05em" }}>
            <div style={{ width: "24px" }} />
            <div style={{ width: "32px" }} />
            <div style={{ flex: 1 }}>ユーザー</div>
            <div>件数 / 的中率</div>
            <div style={{ minWidth: "50px", textAlign: "right" }}>総合</div>
            <div style={{ minWidth: "60px", textAlign: "right" }}>ポイント</div>
          </div>
          {leaderboard.map((u, i) => (
            <div
              key={u.voterId}
              style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 12px", background: "#1a1a1a", borderRadius: "3px", border: `1px solid ${palette.border}` }}
            >
              <div style={{ fontSize: "13px", fontWeight: "800", color: palette.muted, width: "24px" }}>#{i + 1}</div>
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  overflow: "hidden",
                  background: palette.border,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "12px",
                  fontWeight: "700",
                  color: palette.accent,
                  flexShrink: 0,
                }}
              >
                {u.avatarUrl ? (
                  <img src={u.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  initials(u.displayName)
                )}
              </div>
              <div style={{ flex: 1, fontSize: "13px", fontWeight: "600" }}>{u.displayName}</div>
              <div style={{ fontSize: "11px", color: palette.muted }}>
                {u.total}件 / 的中{u.correctCount}件（{u.rate}%）
              </div>
              <div style={{ fontSize: "13px", fontWeight: "800", color: "#c792ff", minWidth: "50px", textAlign: "right" }}>
                {u.combinedScore !== null ? u.combinedScore : "ー"}
              </div>
              <div style={{ fontSize: "13px", fontWeight: "800", color: u.points >= 0 ? palette.green : palette.danger, minWidth: "60px", textAlign: "right" }}>
                {u.points >= 0 ? `+${u.points}` : u.points}pt
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ADMIN SCREEN ────────────────────────────────────────────────
function AdminScreen({ data, refresh, onOpenRoom }) {
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ question: "", options: ["", ""], multiple: false, categoryId: "", startsAt: "", endsAt: "", correctPoints: "10", incorrectPoints: "0", reasonLockAt: "" });
  const [showNew, setShowNew] = useState(false);
  const [showCatManager, setShowCatManager] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [filterCat, setFilterCat] = useState(null);
  const [openResolve, setOpenResolve] = useState({});
  const [correctDraft, setCorrectDraft] = useState({});

  const openNew = () => {
    setForm({ question: "", options: ["", ""], multiple: false, categoryId: "", startsAt: "", endsAt: "", correctPoints: "10", incorrectPoints: "0", reasonLockAt: "" });
    setEditId(null);
    setShowNew(true);
  };

  const openEdit = (poll) => {
    setForm({
      question: poll.question,
      options: [...poll.options],
      multiple: poll.multiple,
      categoryId: poll.categoryId || "",
      startsAt: toDatetimeLocalValue(poll.startsAt),
      endsAt: toDatetimeLocalValue(poll.endsAt),
      correctPoints: String(poll.correctPoints ?? 10),
      incorrectPoints: String(poll.incorrectPoints ?? 0),
      reasonLockAt: toDatetimeLocalValue(poll.reasonLockAt),
    });
    setEditId(poll.id);
    setShowNew(true);
  };

  const closeForm = () => { setShowNew(false); setEditId(null); };

  const saveForm = async () => {
    if (!form.question.trim() || form.options.filter((o) => o.trim()).length < 2) return;
    const cleanOpts = form.options.filter((o) => o.trim());
    const categoryId = form.categoryId || null;
    const startsAt = form.startsAt ? new Date(form.startsAt).toISOString() : null;
    const endsAt = form.endsAt ? new Date(form.endsAt).toISOString() : null;
    const correctPoints = Math.max(0, Number(form.correctPoints) || 0);
    const incorrectPoints = Math.max(0, Number(form.incorrectPoints) || 0);
    const reasonLockAt = form.reasonLockAt ? new Date(form.reasonLockAt).toISOString() : null;
    if (editId) {
      // 選択肢が変わるとインデックスの意味が変わるため、過去の個別投票記録と正解設定はクリアする
      await supabase.from("polls").update({
        question: form.question,
        options: cleanOpts,
        multiple: form.multiple,
        category_id: categoryId,
        resolved: false,
        correct_options: [],
        starts_at: startsAt,
        ends_at: endsAt,
        correct_points: correctPoints,
        incorrect_points: incorrectPoints,
        reason_lock_at: reasonLockAt,
      }).eq("id", editId);
      await supabase.from("vote_records").delete().eq("poll_id", editId);
    } else {
      await supabase.from("polls").insert({
        question: form.question,
        options: cleanOpts,
        multiple: form.multiple,
        active: true,
        category_id: categoryId,
        resolved: false,
        correct_options: [],
        starts_at: startsAt,
        ends_at: endsAt,
        correct_points: correctPoints,
        incorrect_points: incorrectPoints,
        reason_lock_at: reasonLockAt,
      });
    }
    closeForm();
    await refresh();
  };

  const toggleActive = async (id) => {
    const poll = data.polls.find((p) => p.id === id);
    await supabase.from("polls").update({ active: !poll.active }).eq("id", id);
    await refresh();
  };

  const deletePoll = async (id) => {
    await supabase.from("polls").delete().eq("id", id);
    await refresh();
  };

  const resetVotes = async (id) => {
    await supabase.from("vote_records").delete().eq("poll_id", id);
    await refresh();
  };

  const toggleResolveOpen = (pollId) => {
    setOpenResolve((prev) => ({ ...prev, [pollId]: !prev[pollId] }));
  };

  const getDraft = (poll) => (correctDraft[poll.id] !== undefined ? correctDraft[poll.id] : (poll.correctOptions || []));

  const toggleDraftOption = (poll, idx) => {
    setCorrectDraft((prev) => {
      const cur = prev[poll.id] !== undefined ? prev[poll.id] : (poll.correctOptions || []);
      let next;
      if (poll.multiple) {
        next = cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx];
      } else {
        next = [idx];
      }
      return { ...prev, [poll.id]: next };
    });
  };

  const confirmResolve = async (poll) => {
    const draft = getDraft(poll);
    if (draft.length === 0) return;
    await supabase.from("polls").update({ resolved: true, correct_options: [...draft].sort((a, b) => a - b), resolved_at: new Date().toISOString() }).eq("id", poll.id);
    setOpenResolve((prev) => ({ ...prev, [poll.id]: false }));
    await refresh();
  };

  const unresolvePoll = async (pollId) => {
    await supabase.from("polls").update({ resolved: false, correct_options: [], resolved_at: null }).eq("id", pollId);
    setCorrectDraft((prev) => ({ ...prev, [pollId]: [] }));
    await refresh();
  };

  const getCategory = (id) => data.categories.find((c) => c.id === id) || null;
  const visiblePolls = data.polls.filter((p) => filterCat === null || p.categoryId === filterCat);

  return (
    <div style={styles.main}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", gap: "8px", flexWrap: "wrap" }}>
        <div style={styles.sectionTitle}>管理画面</div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            style={{ ...styles.submitBtn, marginTop: 0, background: "transparent", color: palette.muted, border: `1px solid ${palette.border}` }}
            onClick={() => setShowLeaderboard((s) => !s)}
          >
            {showLeaderboard ? "成績一覧を閉じる" : "👥 全員の成績を見る"}
          </button>
          <button
            style={{ ...styles.submitBtn, marginTop: 0, background: "transparent", color: palette.muted, border: `1px solid ${palette.border}` }}
            onClick={() => setShowCatManager((s) => !s)}
          >
            {showCatManager ? "テーマ管理を閉じる" : "🏷 テーマを管理"}
          </button>
        </div>
      </div>

      {showLeaderboard && <AdminLeaderboard data={data} />}

      {showCatManager && <CategoryManager data={data} refresh={refresh} onOpenRoom={onOpenRoom} />}

      {data.categories.length > 0 && (
        <CategoryFilterBar categories={data.categories} selected={filterCat} onSelect={setFilterCat} />
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <div style={styles.sectionTitle}>質問一覧 — {visiblePolls.length}件</div>
        <button style={styles.submitBtn} onClick={openNew}>+ 新規作成</button>
      </div>

      {showNew && (
        <div style={{ ...styles.card, borderColor: palette.accent }}>
          <div style={styles.sectionTitle}>{editId ? "質問を編集" : "新しい質問"}</div>

          <label style={styles.label}>質問文</label>
          <input
            style={styles.input}
            placeholder="質問を入力..."
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
          />

          <label style={styles.label}>テーマ</label>
          <select
            style={styles.select}
            value={form.categoryId}
            onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
          >
            <option value="">未分類</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <label style={styles.label}>選択肢</label>
          {form.options.map((opt, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <input
                style={{ ...styles.input, marginBottom: 0, flex: 1 }}
                placeholder={`選択肢 ${i + 1}`}
                value={opt}
                onChange={(e) => {
                  const opts = [...form.options];
                  opts[i] = e.target.value;
                  setForm({ ...form, options: opts });
                }}
              />
              {form.options.length > 2 && (
                <button style={styles.removeBtn} onClick={() => setForm({ ...form, options: form.options.filter((_, j) => j !== i) })}>×</button>
              )}
            </div>
          ))}
          <button style={styles.addBtn} onClick={() => setForm({ ...form, options: [...form.options, ""] })}>
            + 選択肢を追加
          </button>

          <div style={{ display: "flex", gap: "12px" }}>
            <div style={{ flex: 1 }}>
              <label style={styles.label}>公開開始日時（任意）</label>
              <input
                type="datetime-local"
                style={styles.input}
                value={form.startsAt}
                onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.label}>公開終了日時（任意）</label>
              <input
                type="datetime-local"
                style={styles.input}
                value={form.endsAt}
                onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              />
            </div>
          </div>
          <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "16px", marginTop: "-8px" }}>
            空欄のままにすると、今までと同じ「公開する」ボタンでの手動切り替えのみになります
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <div style={{ flex: 1 }}>
              <label style={styles.label}>正解時に獲得するポイント</label>
              <input
                type="number"
                min="0"
                style={styles.input}
                value={form.correctPoints}
                onChange={(e) => setForm({ ...form, correctPoints: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.label}>不正解時に失うポイント</label>
              <input
                type="number"
                min="0"
                style={styles.input}
                value={form.incorrectPoints}
                onChange={(e) => setForm({ ...form, incorrectPoints: e.target.value })}
              />
            </div>
          </div>
          <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "16px", marginTop: "-8px" }}>
            「失うポイント」はプラスの数で入力してください（自動的に減点されます）
          </div>

          <label style={styles.label}>理由コメントの変更期限（任意）</label>
          <input
            type="datetime-local"
            style={styles.input}
            value={form.reasonLockAt}
            onChange={(e) => setForm({ ...form, reasonLockAt: e.target.value })}
          />
          <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "16px", marginTop: "-8px" }}>
            空欄の場合、結果確定までは自由に編集できます。日時を指定すると、結果確定前でもその時刻でロックされます
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
            <input
              type="checkbox"
              id="multiple"
              checked={form.multiple}
              onChange={(e) => setForm({ ...form, multiple: e.target.checked })}
              style={{ accentColor: palette.accent, width: "16px", height: "16px", cursor: "pointer" }}
            />
            <label htmlFor="multiple" style={{ ...styles.label, marginBottom: 0, cursor: "pointer" }}>複数選択を許可</label>
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <button style={styles.submitBtn} onClick={saveForm}>保存</button>
            <button style={{ ...styles.submitBtn, background: "transparent", color: palette.muted, border: `1px solid ${palette.border}` }} onClick={closeForm}>キャンセル</button>
          </div>
        </div>
      )}

      {visiblePolls.length === 0 && !showNew && (
        <div style={{ ...styles.card, textAlign: "center", padding: "60px 28px" }}>
          <div style={{ color: palette.muted, fontSize: "14px" }}>質問がまだありません</div>
        </div>
      )}

      {visiblePolls.map((poll) => {
        const total = poll.votes.reduce((a, b) => a + b, 0);
        const cat = getCategory(poll.categoryId);
        const isOpen = !!openResolve[poll.id];
        const draft = getDraft(poll);
        const status = pollStatusLabel(poll);
        return (
          <div key={poll.id} style={styles.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
              <div style={{ flex: 1, paddingRight: "16px" }}>
                <CategoryTag category={cat} onOpenRoom={onOpenRoom} />
                <div style={{ fontSize: "16px", fontWeight: "700", marginBottom: "6px" }}>{poll.question}</div>
                <div style={{ fontSize: "12px", color: palette.muted }}>
                  {poll.options.length}択 · {poll.multiple ? "複数選択可" : "単一選択"} · {total}票
                </div>
                {(poll.startsAt || poll.endsAt) && (
                  <div style={{ fontSize: "11px", color: palette.muted, marginTop: "4px" }}>
                    📅 {poll.startsAt ? formatDateTime(poll.startsAt) : "開始日時未設定"} 〜 {poll.endsAt ? formatDateTime(poll.endsAt) : "終了日時未設定"}
                  </div>
                )}
                <div style={{ fontSize: "11px", color: palette.muted, marginTop: "4px" }}>
                  🏆 正解 +{poll.correctPoints}pt ／ 不正解 -{poll.incorrectPoints}pt
                </div>
                <div style={{ fontSize: "11px", color: palette.muted, marginTop: "4px" }}>
                  💬 理由コメント変更期限：{poll.reasonLockAt ? formatDateTime(poll.reasonLockAt) : "結果確定まで自由"}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end" }}>
                <span style={{ ...styles.badge(true), color: status.color, border: `1px solid ${status.color}`, background: "transparent" }}>{status.text}</span>
                {poll.resolved && (
                  <span style={{ ...styles.badge(true), background: "rgba(232,255,71,0.12)", color: palette.accent, border: `1px solid ${palette.accent}` }}>
                    🎯 正解設定済み
                  </span>
                )}
              </div>
            </div>

            {poll.options.map((opt, i) => {
              const pct = total > 0 ? Math.round((poll.votes[i] / total) * 100) : 0;
              const isCorrectOpt = poll.resolved && (poll.correctOptions || []).includes(i);
              return (
                <div key={i} style={{ marginBottom: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
                    <span style={{ color: isCorrectOpt ? palette.green : palette.text }}>{isCorrectOpt && "🎯 "}{opt}</span>
                    <span style={{ color: palette.muted }}>{poll.votes[i]}票 ({pct}%)</span>
                  </div>
                  <div style={{ background: palette.border, borderRadius: "2px", height: "4px" }}>
                    <div style={styles.resultBar(pct, isCorrectOpt ? palette.green : palette.accent)} />
                  </div>
                </div>
              );
            })}

            <div style={{ marginTop: "14px", borderTop: `1px solid ${palette.border}`, paddingTop: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: "11px", color: poll.resolved ? palette.accent : palette.muted, letterSpacing: "0.04em", fontWeight: "700" }}>
                  {poll.resolved
                    ? `🎯 正解：${poll.correctOptions.map((i) => poll.options[i]).join("、")}`
                    : "正解はまだ未設定（的中率トラッキングに使われます）"}
                </div>
                <button
                  style={{ ...styles.removeBtn, color: palette.muted, fontSize: "11px" }}
                  onClick={() => toggleResolveOpen(poll.id)}
                >
                  {isOpen ? "閉じる" : poll.resolved ? "正解を変更" : "正解を設定"}
                </button>
              </div>

              {isOpen && (
                <div style={{ marginTop: "12px" }}>
                  <div style={{ fontSize: "11px", color: palette.muted, marginBottom: "8px" }}>
                    投票期間終了後（非公開化後）に設定するのがおすすめです
                  </div>
                  {poll.options.map((opt, i) => (
                    <label key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", fontSize: "13px", cursor: "pointer" }}>
                      <input
                        type={poll.multiple ? "checkbox" : "radio"}
                        checked={draft.includes(i)}
                        onChange={() => toggleDraftOption(poll, i)}
                        style={{ accentColor: palette.accent, width: "15px", height: "15px", cursor: "pointer" }}
                      />
                      {opt}
                    </label>
                  ))}
                  <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                    <button style={{ ...styles.submitBtn, padding: "10px 16px", fontSize: "11px" }} onClick={() => confirmResolve(poll)}>
                      {poll.resolved ? "正解を更新" : "正解として確定"}
                    </button>
                    {poll.resolved && (
                      <button
                        style={{ ...styles.submitBtn, padding: "10px 16px", fontSize: "11px", background: "transparent", color: palette.danger, border: `1px solid ${palette.danger}` }}
                        onClick={() => unresolvePoll(poll.id)}
                      >
                        正解設定を解除
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", marginTop: "16px", flexWrap: "wrap" }}>
              <button style={{ ...styles.submitBtn, padding: "10px 16px", fontSize: "11px" }} onClick={() => openEdit(poll)}>編集</button>
              <button style={{ ...styles.submitBtn, padding: "10px 16px", fontSize: "11px", background: poll.active ? palette.danger : palette.green, color: "#000" }} onClick={() => toggleActive(poll.id)}>
                {poll.active ? "非公開にする" : "公開する"}
              </button>
              <button
                style={{ ...styles.submitBtn, padding: "10px 16px", fontSize: "11px", background: "transparent", color: palette.muted, border: `1px solid ${palette.border}` }}
                onClick={() => resetVotes(poll.id)}
              >
                票をリセット
              </button>
              <button style={{ ...styles.submitBtn, padding: "10px 16px", fontSize: "11px", background: "transparent", color: palette.danger, border: `1px solid ${palette.danger}` }} onClick={() => deletePoll(poll.id)}>
                削除
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── 成績（的中率トラッキング）画面 ─────────────────────────────
// ログイン中のユーザーのIDを使って、本人の投票記録を集計する
function MyRecordScreen({ data, session, onRequestLogin, onOpenRoom }) {
  if (!session) {
    return (
      <div style={styles.main}>
        <div style={styles.sectionTitle}>成績 — 的中率トラッキング</div>
        <LoginPrompt message="成績を見るにはログインが必要です" onRequestLogin={onRequestLogin} />
      </div>
    );
  }

  const voterId = session.user.id;
  const myRecords = (data.voteRecords || []).filter((r) => r.voterId === voterId);

  const history = myRecords
    .map((r) => {
      const poll = data.polls.find((p) => p.id === r.pollId);
      if (!poll) return null;
      return { record: r, poll, correct: isCorrectSelection(poll, r.selectedOptions), points: pointsForRecord(poll, r.selectedOptions) };
    })
    .filter(Boolean)
    .sort((a, b) => b.record.ts - a.record.ts);

  const resolvedHistory = history.filter((h) => h.correct !== null);
  const pendingHistory = history.filter((h) => h.correct === null);
  const total = resolvedHistory.length;
  const correctCount = resolvedHistory.filter((h) => h.correct).length;
  const rate = total > 0 ? Math.round((correctCount / total) * 100) : 0;
  const totalPoints = resolvedHistory.reduce((sum, h) => sum + (h.points || 0), 0);

  const reasonsWritten = resolvedHistory.filter((h) => h.record.reason && h.record.reason.trim());
  const reasonsWithInsight = reasonsWritten.filter((h) => insightCountFor(data, h.record.id) > 0);
  const insightRate = reasonsWritten.length > 0 ? Math.round((reasonsWithInsight.length / reasonsWritten.length) * 100) : null;
  const combinedScore = computeCombinedScore(total, correctCount, reasonsWritten.length, reasonsWithInsight.length);

  const getCategory = (id) => data.categories.find((c) => c.id === id) || null;

  return (
    <div style={styles.main}>
      <div style={styles.sectionTitle}>成績 — 的中率トラッキング</div>

      <div style={{ ...styles.card, textAlign: "center", padding: "28px 20px" }}>
        <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginBottom: "8px" }}>総合スコア</div>
        <div style={{ fontSize: "42px", fontWeight: "800", color: "#c792ff" }}>
          {combinedScore !== null ? combinedScore : "ー"}
        </div>
        <div style={{ fontSize: "11px", color: palette.muted, marginTop: "8px", lineHeight: 1.6 }}>
          {combinedScore !== null
            ? "的中率と鋭い視点レート、両方を反映したスコアです（コメント数や投票数自体では上がりません）"
            : `確定済みの予測が${MIN_SCORE_SAMPLE}件以上になると表示されます（現在${total}件）`}
        </div>
      </div>

      <div style={{ ...styles.card, display: "flex", gap: "24px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 100px" }}>
          <div style={{ fontSize: "28px", fontWeight: "800", color: palette.text }}>{total}</div>
          <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginTop: "4px" }}>確定済み予測数</div>
        </div>
        <div style={{ flex: "1 1 100px" }}>
          <div style={{ fontSize: "28px", fontWeight: "800", color: palette.green }}>{correctCount}</div>
          <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginTop: "4px" }}>的中数</div>
        </div>
        <div style={{ flex: "1 1 100px" }}>
          <div style={{ fontSize: "28px", fontWeight: "800", color: palette.accent }}>{total > 0 ? `${rate}%` : "—"}</div>
          <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginTop: "4px" }}>的中率</div>
        </div>
        <div style={{ flex: "1 1 100px" }}>
          <div style={{ fontSize: "28px", fontWeight: "800", color: "#c792ff" }}>{insightRate !== null ? `${insightRate}%` : "—"}</div>
          <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginTop: "4px" }}>💡 鋭い視点レート</div>
        </div>
        <div style={{ flex: "1 1 100px" }}>
          <div style={{ fontSize: "28px", fontWeight: "800", color: totalPoints >= 0 ? palette.green : palette.danger }}>
            {totalPoints >= 0 ? `+${totalPoints}` : totalPoints}
          </div>
          <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginTop: "4px" }}>獲得ポイント</div>
        </div>
        {pendingHistory.length > 0 && (
          <div style={{ flex: "1 1 100px" }}>
            <div style={{ fontSize: "28px", fontWeight: "800", color: palette.muted }}>{pendingHistory.length}</div>
            <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.08em", marginTop: "4px" }}>結果待ち</div>
          </div>
        )}
      </div>

      <div style={{ ...styles.sectionTitle, marginTop: "8px" }}>予測履歴</div>

      {history.length === 0 ? (
        <div style={{ ...styles.card, textAlign: "center", padding: "60px 28px" }}>
          <div style={{ fontSize: "32px", marginBottom: "16px" }}>🎯</div>
          <div style={{ color: palette.muted, fontSize: "14px", letterSpacing: "0.08em" }}>
            まだ投票した質問がありません
          </div>
        </div>
      ) : (
        history.map(({ record, poll, correct, points }) => {
          const cat = getCategory(poll.categoryId);
          const yourAnswer = record.selectedOptions.map((i) => poll.options[i]).join("、");
          return (
            <div key={record.id} style={styles.card}>
              <CategoryTag category={cat} onOpenRoom={onOpenRoom} />
              <div style={{ fontSize: "15px", fontWeight: "700", marginBottom: "10px" }}>{poll.question}</div>
              <div style={{ fontSize: "12px", color: palette.muted, marginBottom: "6px" }}>あなたの回答：{yourAnswer}</div>
              {record.reason && record.reason.trim() && (
                <div style={{ fontSize: "12px", color: palette.muted, marginBottom: "6px" }}>
                  あなたの理由：「{record.reason}」
                  {poll.resolved && (
                    <span style={{ color: "#c792ff", fontWeight: "700" }}> ・💡 鋭い視点 {insightCountFor(data, record.id)}</span>
                  )}
                </div>
              )}
              {correct === null ? (
                <span style={{ ...styles.badge(false), background: "rgba(136,136,136,0.12)", color: palette.muted, border: `1px solid ${palette.border}` }}>
                  結果待ち
                </span>
              ) : correct ? (
                <>
                  <span style={styles.badge(true)}>🎯 的中</span>
                  <span style={{ marginLeft: "10px", fontSize: "12px", fontWeight: "700", color: palette.green }}>+{points}pt</span>
                </>
              ) : (
                <>
                  <span style={styles.badge(false)}>不正解</span>
                  <span style={{ marginLeft: "10px", fontSize: "12px", fontWeight: "700", color: palette.danger }}>{points}pt</span>
                  <div style={{ fontSize: "12px", color: palette.green, marginTop: "8px" }}>
                    正解：{poll.correctOptions.map((i) => poll.options[i]).join("、")}
                  </div>
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}


// ─── プロフィール設定画面 ───────────────────────────────────────
function ProfileScreen({ session, profile, onProfileUpdated, onBack }) {
  const [displayName, setDisplayName] = useState(profile?.display_name || "");
  const [bio, setBio] = useState(profile?.bio || "");
  const [email, setEmail] = useState(session?.user?.email || "");
  const [avatarPreview, setAvatarPreview] = useState(profile?.avatar_url || null);
  const [uploading, setUploading] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const handleAvatarChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setError("");
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "jpg";
    const path = `${session.user.id}/avatar.${ext}`;
    const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
    if (uploadError) {
      setError(uploadError.message);
      setUploading(false);
      return;
    }
    const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(path);
    const cacheBusted = `${urlData.publicUrl}?t=${Date.now()}`;
    await supabase.from("profiles").update({ avatar_url: cacheBusted }).eq("id", session.user.id);
    setAvatarPreview(cacheBusted);
    setUploading(false);
    onProfileUpdated && onProfileUpdated();
  };

  const saveProfile = async () => {
    if (!displayName.trim()) {
      setError("表示名を入力してください");
      return;
    }
    setSavingProfile(true);
    setError("");
    setMessage("");
    const { error: saveError } = await supabase
      .from("profiles")
      .update({ display_name: displayName.trim(), bio: bio.trim() })
      .eq("id", session.user.id);
    setSavingProfile(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setMessage("プロフィールを更新しました");
    onProfileUpdated && onProfileUpdated();
  };

  const saveEmail = async () => {
    if (!email.trim()) return;
    setSavingEmail(true);
    setError("");
    setMessage("");
    const { error: emailError } = await supabase.auth.updateUser({ email: email.trim() });
    setSavingEmail(false);
    if (emailError) {
      setError(emailError.message);
      return;
    }
    setMessage("確認メールを送信しました。新しいメールアドレス宛のリンクをクリックすると変更が完了します。");
  };

  return (
    <div style={styles.main}>
      <button style={styles.backLink} onClick={onBack}>← 戻る</button>
      <div style={styles.sectionTitle}>プロフィール設定</div>

      <div style={styles.card}>
        <label style={styles.label}>アイコン画像</label>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "20px" }}>
          <div
            style={{
              width: "64px",
              height: "64px",
              borderRadius: "50%",
              overflow: "hidden",
              background: palette.border,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "22px",
              fontWeight: "700",
              color: palette.accent,
              flexShrink: 0,
            }}
          >
            {avatarPreview ? (
              <img src={avatarPreview} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              initials(displayName)
            )}
          </div>
          <label style={{ ...styles.submitBtn, marginTop: 0, cursor: "pointer", display: "inline-block", opacity: uploading ? 0.6 : 1 }}>
            {uploading ? "アップロード中..." : "画像を選ぶ"}
            <input type="file" accept="image/*" onChange={handleAvatarChange} style={{ display: "none" }} disabled={uploading} />
          </label>
        </div>

        <label style={styles.label}>表示名</label>
        <input style={styles.input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />

        <label style={styles.label}>自己紹介</label>
        <textarea
          style={{ ...styles.textarea, width: "100%", boxSizing: "border-box", marginBottom: "16px" }}
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="自己紹介（任意）"
        />

        <button style={{ ...styles.submitBtn, opacity: savingProfile ? 0.6 : 1 }} onClick={saveProfile} disabled={savingProfile}>
          {savingProfile ? "保存中..." : "プロフィールを保存"}
        </button>
      </div>

      <div style={styles.card}>
        <label style={styles.label}>メールアドレス</label>
        <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button style={{ ...styles.submitBtn, opacity: savingEmail ? 0.6 : 1 }} onClick={saveEmail} disabled={savingEmail}>
          {savingEmail ? "送信中..." : "メールアドレスを変更"}
        </button>
        <div style={{ fontSize: "11px", color: palette.muted, marginTop: "10px" }}>
          変更後、新しいメールアドレス宛に確認メールが届きます。リンクをクリックするまで現在のメールアドレスのままです。
        </div>
      </div>

      {message && <div style={{ color: palette.green, fontSize: "13px", marginTop: "8px" }}>{message}</div>}
      {error && <div style={{ color: palette.danger, fontSize: "13px", marginTop: "8px" }}>{error}</div>}
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("vote");
  const [data, setData] = useState(null); // null = 読み込み中
  const [error, setError] = useState(null);
  const [activeRoom, setActiveRoom] = useState(null); // categoryId or null
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [showAuthForm, setShowAuthForm] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(() => {
    try {
      return localStorage.getItem(ADMIN_UNLOCK_KEY) === "true";
    } catch {
      return false;
    }
  });

  const refresh = async () => {
    try {
      const fresh = await fetchAllData();
      setData(fresh);
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e.message || "データの取得に失敗しました");
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const refreshProfile = async () => {
    if (!session) {
      setProfile(null);
      return;
    }
    const { data } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    setProfile(data);
  };

  useEffect(() => {
    refreshProfile();
  }, [session]);

  useEffect(() => {
    const link = document.createElement("link");
    link.href = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }, []);

  const openRoom = (categoryId) => setActiveRoom(categoryId);
  const closeRoom = () => setActiveRoom(null);
  const requestLogin = () => setShowAuthForm(true);
  const handleLogout = async () => {
    await supabase.auth.signOut();
  };
  const displayName = profile?.display_name || session?.user?.email || "ゲスト";
  const avatarUrl = profile?.avatar_url || null;

  if (error) {
    return (
      <div style={styles.app}>
        <div style={{ padding: "60px 32px", color: palette.danger, fontSize: "13px", lineHeight: 1.8 }}>
          データの読み込みに失敗しました。<br />
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={styles.app}>
        <div style={{ padding: "60px 32px", color: palette.muted, fontSize: "13px", letterSpacing: "0.08em" }}>
          読み込み中...
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <div style={styles.logo}>◈ Pollr</div>
        <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
          <div style={{ fontSize: "11px", color: palette.muted, letterSpacing: "0.1em" }}>
            {data.polls.filter((p) => p.active).length} 件公開中
          </div>
          {session ? (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px" }}>
              <button
                style={{ background: "none", border: "none", color: palette.accent, cursor: "pointer", fontFamily: "inherit", fontSize: "12px", padding: 0 }}
                onClick={() => setShowProfile(true)}
              >
                {displayName}
              </button>
              <button style={{ ...styles.removeBtn, color: palette.muted, fontSize: "11px" }} onClick={handleLogout}>
                ログアウト
              </button>
            </div>
          ) : (
            <button
              style={{ ...styles.submitBtn, marginTop: 0, padding: "8px 16px", fontSize: "11px" }}
              onClick={() => setShowAuthForm((s) => !s)}
            >
              ログイン
            </button>
          )}
        </div>
      </div>

      {!session && showAuthForm && (
        <div style={{ padding: "24px 32px 0" }}>
          <AuthForm onSuccess={() => setShowAuthForm(false)} />
        </div>
      )}

      {activeRoom === null && !showProfile && (
        <div style={styles.tabBar}>
          <button style={styles.tab(tab === "vote")} onClick={() => setTab("vote")}>投票する</button>
          <button style={styles.tab(tab === "discuss")} onClick={() => setTab("discuss")}>🗣️ 議論</button>
          <button style={styles.tab(tab === "feed")} onClick={() => setTab("feed")}>📣 フィード</button>
          <button style={styles.tab(tab === "record")} onClick={() => setTab("record")}>🎯 成績</button>
          <button style={styles.tab(tab === "admin")} onClick={() => setTab("admin")}>管理画面</button>
        </div>
      )}

      {showProfile ? (
        <ProfileScreen session={session} profile={profile} onProfileUpdated={refreshProfile} onBack={() => setShowProfile(false)} />
      ) : activeRoom !== null ? (
        <DiscussionRoom data={data} refresh={refresh} categoryId={activeRoom} onBack={closeRoom} session={session} displayName={displayName} avatarUrl={avatarUrl} onRequestLogin={requestLogin} />
      ) : tab === "vote" ? (
        <VoteScreen data={data} refresh={refresh} onOpenRoom={openRoom} session={session} onRequestLogin={requestLogin} />
      ) : tab === "discuss" ? (
        <DiscussionBrowseScreen data={data} onOpenRoom={openRoom} />
      ) : tab === "feed" ? (
        <FeedScreen data={data} refresh={refresh} session={session} displayName={displayName} avatarUrl={avatarUrl} onRequestLogin={requestLogin} />
      ) : tab === "record" ? (
        <MyRecordScreen data={data} session={session} onRequestLogin={requestLogin} onOpenRoom={openRoom} />
      ) : adminUnlocked ? (
        <AdminScreen data={data} refresh={refresh} onOpenRoom={openRoom} />
      ) : (
        <AdminGate onUnlock={() => setAdminUnlocked(true)} />
      )}
    </div>
  );
}
