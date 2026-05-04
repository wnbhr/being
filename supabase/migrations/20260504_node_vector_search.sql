-- spec-946: ノードレベルベクトル検索
-- 次元: 256 → 1536 統一
-- memory_nodesにvectorカラム追加 + match_nodes RPC作成
-- match_clusters RPCを1536次元に更新

-- ノードvectorカラム追加
ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS vector vector(1536);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_vector ON memory_nodes USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);

-- クラスタvector次元変更（256 → 1536）
-- 既存のベクトルはNULLクリアしてバックフィルで再計算
ALTER TABLE clusters DROP COLUMN IF EXISTS vector;
ALTER TABLE clusters ADD COLUMN vector vector(1536);
CREATE INDEX IF NOT EXISTS idx_clusters_vector ON clusters USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);

-- match_nodes RPC（新規作成）
CREATE OR REPLACE FUNCTION match_nodes(
  p_user_id UUID,
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.35,
  match_count INT DEFAULT 5,
  p_being_id UUID DEFAULT NULL
)
RETURNS TABLE (id UUID, cluster_id UUID, similarity FLOAT)
LANGUAGE sql STABLE
AS $$
  SELECT mn.id, mn.cluster_id,
    1 - (mn.vector <=> query_embedding) AS similarity
  FROM memory_nodes mn
  WHERE mn.user_id = p_user_id
    AND mn.vector IS NOT NULL
    AND mn.status = 'active'
    AND (p_being_id IS NULL OR mn.being_id = p_being_id)
    AND 1 - (mn.vector <=> query_embedding) > match_threshold
  ORDER BY mn.vector <=> query_embedding
  LIMIT match_count;
$$;

-- match_clusters RPCを1536次元に更新
CREATE OR REPLACE FUNCTION match_clusters(
  p_user_id UUID,
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.45,
  match_count INT DEFAULT 5,
  p_being_id UUID DEFAULT NULL
)
RETURNS TABLE (id UUID, name TEXT, similarity FLOAT)
LANGUAGE sql STABLE
AS $$
  SELECT clusters.id, clusters.name,
    1 - (clusters.vector <=> query_embedding) AS similarity
  FROM clusters
  WHERE clusters.user_id = p_user_id
    AND clusters.vector IS NOT NULL
    AND (clusters.is_parent IS NULL OR clusters.is_parent = FALSE)
    AND (p_being_id IS NULL OR clusters.being_id = p_being_id)
    AND 1 - (clusters.vector <=> query_embedding) > match_threshold
  ORDER BY clusters.vector <=> query_embedding
  LIMIT match_count;
$$;
