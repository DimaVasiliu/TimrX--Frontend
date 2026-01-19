import os, json, time, base64, uuid
import boto3
from pathlib import Path
from dotenv import load_dotenv
from typing import Dict, Any
from urllib.parse import urlparse
from datetime import datetime

load_dotenv()

import requests
try:
    import psycopg2
    import psycopg2.extras
except Exception:
    psycopg2 = None
from flask import Flask, request, jsonify, Response, abort
from flask_cors import CORS

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────
APP_DIR = Path(__file__).resolve().parent
STORE_PATH = APP_DIR / "job_store.json"
CACHE_DIR = APP_DIR / "cache_images"
CACHE_DIR.mkdir(exist_ok=True)
HISTORY_STORE_PATH = APP_DIR / "history_store.json"
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
USE_DB = bool(DATABASE_URL and psycopg2)

# ─────────────────────────────────────────────────────────────
# AWS S3 Config
# ─────────────────────────────────────────────────────────────
AWS_REGION = os.getenv("AWS_REGION", "eu-west-2")
AWS_BUCKET_MODELS = os.getenv("AWS_BUCKET_MODELS", "")

s3 = boto3.client(
    "s3",
    region_name=AWS_REGION,
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)

def upload_bytes_to_s3(data_bytes: bytes, content_type: str = "application/octet-stream", prefix: str = "models") -> str:
    """
    Upload raw bytes to S3 and return the public URL.
    prefix: folder prefix, e.g. 'models', 'images', 'thumbnails'
    """
    if not AWS_BUCKET_MODELS:
        raise RuntimeError("AWS_BUCKET_MODELS not configured")
    key = f"{prefix}/{uuid.uuid4().hex}"
    s3.put_object(
        Bucket=AWS_BUCKET_MODELS,
        Key=key,
        Body=data_bytes,
        ContentType=content_type,
        ACL="public-read",
    )
    return f"https://{AWS_BUCKET_MODELS}.s3.{AWS_REGION}.amazonaws.com/{key}"

def upload_url_to_s3(url: str, content_type: str = None, prefix: str = "models") -> str:
    """
    Download file from URL and upload to S3.
    Returns the S3 public URL.
    """
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    ct = content_type or resp.headers.get("Content-Type", "application/octet-stream")
    return upload_bytes_to_s3(resp.content, ct, prefix)

def safe_upload_to_s3(url: str, content_type: str, prefix: str) -> str:
    """
    Safely upload URL to S3, returning original URL if S3 upload fails.
    """
    if not url or not AWS_BUCKET_MODELS:
        return url
    try:
        s3_url = upload_url_to_s3(url, content_type, prefix)
        print(f"[S3] Uploaded {prefix}: {url[:60]}... -> {s3_url}")
        return s3_url
    except Exception as e:
        print(f"[S3] Failed to upload {prefix}: {e}")
        return url  # Fall back to original URL

MESHY_API_KEY  = os.getenv("MESHY_API_KEY", "").strip()
MESHY_API_BASE = os.getenv("MESHY_API_BASE", "https://api.meshy.ai").rstrip("/")

# OpenAI images (DALL·E / GPT-Image)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
ALLOWED_IMAGE_HOSTS = {
    "oaidalleapiprodscus.blob.core.windows.net",
    "oaidalleapiprodscus.bblob.core.windows.net",  # sometimes typoed; harmless
    "oaidalleapiprodscus.blob.core.windows.net:443",
}

# Allow all by default (you can restrict with ALLOWED_ORIGINS env)
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")
    if o.strip()
]

app = Flask(__name__)
CORS(
    app,
    resources={r"/api/*": {"origins": ALLOWED_ORIGINS}},
    supports_credentials=False
)
# ─────────────────────────────────────────────────────────────
# Small store for job metadata
# ─────────────────────────────────────────────────────────────
def load_store() -> Dict[str, Any]:
    if not STORE_PATH.exists():
        return {}
    try:
        return json.loads(STORE_PATH.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {}

def save_store(data: Dict[str, Any]) -> None:
    STORE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2))

if not STORE_PATH.exists():
    save_store({})

def load_history_store() -> list:
    if not HISTORY_STORE_PATH.exists():
        return []
    try:
        data = json.loads(HISTORY_STORE_PATH.read_text(encoding="utf-8") or "[]")
        return data if isinstance(data, list) else []
    except Exception:
        return []

def save_history_store(arr: list) -> None:
    try:
        HISTORY_STORE_PATH.write_text(json.dumps(arr, ensure_ascii=False, indent=2))
    except Exception:
        pass

def _local_history_id(item: dict, fallback_id: str = None) -> str | None:
    """
    Pick a stable identifier for local history persistence even when DB is disabled.
    """
    if not isinstance(item, dict):
        return fallback_id
    return item.get("id") or item.get("job_id") or fallback_id

def upsert_history_local(item: dict, *, merge: bool = False) -> bool:
    """
    Persist a history item to the local JSON store when DB is unavailable.
    """
    try:
        item_id = _local_history_id(item)
        if not item_id:
            return False
        arr = load_history_store()
        if not isinstance(arr, list):
            arr = []
        updated = False
        for idx, existing in enumerate(arr):
            if not isinstance(existing, dict):
                continue
            if _local_history_id(existing) == item_id:
                arr[idx] = {**existing, **item} if merge else item
                updated = True
                break
        if not updated:
            arr.insert(0, item)
        save_history_store(arr)
        return True
    except Exception as e:
        print(f"[History] Failed to upsert local history: {e}")
        return False

def delete_history_local(item_id: str) -> bool:
    try:
        arr = load_history_store()
        if not isinstance(arr, list):
            arr = []
        filtered = [
            x for x in arr
            if not (isinstance(x, dict) and _local_history_id(x) == item_id)
        ]
        save_history_store(filtered)
        return True
    except Exception as e:
        print(f"[History] Failed to delete local history item {item_id}: {e}")
        return False

# ─────────────────────────────────────────────────────────────
# Database helpers (Postgres)
# ─────────────────────────────────────────────────────────────
def get_db_conn():
    if not USE_DB:
        return None
    try:
        return psycopg2.connect(DATABASE_URL, connect_timeout=5)
    except Exception:
        return None

def ensure_history_table():
    if not USE_DB:
        return
    conn = get_db_conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS history_items (
                    id TEXT PRIMARY KEY,
                    payload JSONB NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_history_created ON history_items(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_history_type ON history_items((payload->>'type'));
                CREATE INDEX IF NOT EXISTS idx_history_provider ON history_items((payload->>'provider'));
            """)
        conn.close()
    except Exception:
        try:
            conn.close()
        except Exception:
            pass

ensure_history_table()

def ensure_active_jobs_table():
    """Create table for tracking active jobs across page reloads"""
    if not USE_DB:
        return
    conn = get_db_conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS active_jobs (
                    job_id TEXT PRIMARY KEY,
                    job_type TEXT NOT NULL,
                    stage TEXT,
                    metadata JSONB NOT NULL,
                    status TEXT DEFAULT 'active',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_active_jobs_status ON active_jobs(status);
                CREATE INDEX IF NOT EXISTS idx_active_jobs_created ON active_jobs(created_at);
            """)
        conn.close()
    except Exception as e:
        print(f"[DB] Failed to create active_jobs table: {e}")
        try:
            conn.close()
        except Exception:
            pass

ensure_active_jobs_table()

def save_active_job_to_db(job_id: str, job_type: str, stage: str = None, metadata: dict = None):
    """Save active job to database for recovery"""
    if not USE_DB:
        return False
    conn = get_db_conn()
    if not conn:
        return False
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO active_jobs (job_id, job_type, stage, metadata, status)
                VALUES (%s, %s, %s, %s, 'active')
                ON CONFLICT (job_id) DO UPDATE
                SET metadata = EXCLUDED.metadata,
                    stage = EXCLUDED.stage,
                    updated_at = NOW()
            """, (job_id, job_type, stage, json.dumps(metadata or {})))
        conn.close()
        return True
    except Exception as e:
        print(f"[DB] Failed to save active job {job_id}: {e}")
        try:
            conn.close()
        except Exception:
            pass
        return False

def get_active_jobs_from_db():
    """Retrieve all active jobs from database"""
    if not USE_DB:
        return []
    conn = get_db_conn()
    if not conn:
        return []
    try:
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT job_id, job_type, stage, metadata, created_at
                FROM active_jobs
                WHERE status = 'active'
                ORDER BY created_at DESC
            """)
            rows = cur.fetchall()
        conn.close()
        return [dict(row) for row in rows]
    except Exception as e:
        print(f"[DB] Failed to get active jobs: {e}")
        try:
            conn.close()
        except Exception:
            pass
        return []

def mark_job_completed_in_db(job_id: str):
    """Mark job as completed in database"""
    if not USE_DB:
        return
    conn = get_db_conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                UPDATE active_jobs
                SET status = 'completed', updated_at = NOW()
                WHERE job_id = %s
            """, (job_id,))
            # Clean up old completed jobs (keep last 100)
            cur.execute("""
                DELETE FROM active_jobs
                WHERE job_id IN (
                    SELECT job_id FROM active_jobs
                    WHERE status = 'completed'
                    ORDER BY updated_at DESC
                    OFFSET 100
                )
            """)
        conn.close()
    except Exception as e:
        print(f"[DB] Failed to mark job completed {job_id}: {e}")
        try:
            conn.close()
        except Exception:
            pass

def save_image_to_normalized_db(image_id: str, image_url: str, prompt: str, ai_model: str, size: str, image_urls: list = None):
    """
    Save generated image to normalized tables (history_items, images).
    Called immediately after OpenAI image generation completes.
    """
    if not USE_DB:
        return False
    conn = get_db_conn()
    if not conn:
        return False

    try:
        with conn, conn.cursor() as cur:
            created_at_ms = int(time.time() * 1000)

            # Upload images to S3 for permanent storage (OpenAI URLs expire)
            if image_url and not image_url.startswith("data:"):
                image_url = safe_upload_to_s3(image_url, "image/png", "images")
            if image_urls:
                image_urls = [
                    safe_upload_to_s3(url, "image/png", "images")
                    if url and not url.startswith("data:") else url
                    for url in image_urls
                ]

            # Parse size for width/height
            width, height = 1024, 1024
            if size and 'x' in size:
                parts = size.split('x')
                try:
                    width, height = int(parts[0]), int(parts[1])
                except ValueError:
                    pass

            # Insert into history_items
            cur.execute("""
                INSERT INTO history_items (
                    id, type, status, status_label, stage,
                    title, prompt, ai_model,
                    thumbnail_url,
                    progress, created_at
                ) VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s,
                    %s,
                    %s, %s
                )
                ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, history_items.thumbnail_url),
                    updated_at = NOW()
            """, (
                image_id,
                'image',
                'finished',
                'Completed',
                'image',
                prompt[:50] if prompt else 'Generated Image',
                prompt,
                ai_model,
                image_url,
                100,
                created_at_ms
            ))

            # Insert main image
            cur.execute("""
                INSERT INTO images (
                    id, history_item_id,
                    image_url, thumbnail_url, image_type,
                    prompt, ai_model, size,
                    width, height, format
                ) VALUES (
                    %s, %s,
                    %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s
                )
                ON CONFLICT (id) DO NOTHING
            """, (
                image_id,
                image_id,
                image_url,
                image_url,
                'generated',
                prompt,
                ai_model,
                size,
                width,
                height,
                'png'
            ))

            # Insert additional images from batch (if n > 1)
            if image_urls and len(image_urls) > 1:
                for idx, url in enumerate(image_urls[1:], start=1):
                    cur.execute("""
                        INSERT INTO images (
                            id, history_item_id,
                            image_url, thumbnail_url, image_type,
                            prompt, ai_model, size,
                            width, height, format, batch_index
                        ) VALUES (
                            %s, %s,
                            %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s, %s
                        )
                        ON CONFLICT (id) DO NOTHING
                    """, (
                        f"{image_id}_{idx}",
                        image_id,
                        url,
                        url,
                        'generated',
                        prompt,
                        ai_model,
                        size,
                        width,
                        height,
                        'png',
                        idx
                    ))

        conn.close()
        print(f"[DB] Saved image {image_id} to normalized tables")
        return True
    except Exception as e:
        print(f"[DB] Failed to save image {image_id}: {e}")
        try:
            conn.close()
        except Exception:
            pass
        return False

def save_finished_job_to_normalized_db(job_id: str, status_data: dict, job_meta: dict, job_type: str = 'model'):
    """
    Save finished job data to normalized tables (history_items, models, images).
    Called when a job status becomes 'done'.
    """
    if not USE_DB:
        return False
    conn = get_db_conn()
    if not conn:
        return False

    try:
        with conn, conn.cursor() as cur:
            # Merge status_data and job_meta
            glb_url = status_data.get("glb_url") or status_data.get("textured_glb_url")
            thumbnail_url = status_data.get("thumbnail_url")
            model_urls = status_data.get("model_urls") or {}
            textured_model_urls = status_data.get("textured_model_urls") or {}

            # Upload to S3 for permanent storage (Meshy URLs expire)
            if glb_url:
                glb_url = safe_upload_to_s3(glb_url, "model/gltf-binary", "models")
            if thumbnail_url:
                thumbnail_url = safe_upload_to_s3(thumbnail_url, "image/png", "thumbnails")

            # Determine item type
            item_type = 'model'
            if job_type in ('image', 'openai_image'):
                item_type = 'image'

            # Build history_items row
            created_at_ms = status_data.get("created_at") or job_meta.get("created_at") or int(time.time() * 1000)

            cur.execute("""
                INSERT INTO history_items (
                    id, type, status, status_label, stage,
                    title, prompt, art_style, ai_model, license,
                    symmetry_mode, is_a_t_pose,
                    batch_count, batch_slot, batch_group_id,
                    lineage_root_id, preview_task_id, source_task_id,
                    thumbnail_url, cover_image_url,
                    progress, created_at
                ) VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s,
                    %s, %s, %s,
                    %s, %s, %s,
                    %s, %s,
                    %s, %s
                )
                ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    status_label = EXCLUDED.status_label,
                    thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, history_items.thumbnail_url),
                    cover_image_url = COALESCE(EXCLUDED.cover_image_url, history_items.cover_image_url),
                    progress = EXCLUDED.progress,
                    updated_at = NOW()
            """, (
                job_id,
                item_type,
                'finished',
                'Completed',
                status_data.get("stage") or job_meta.get("stage") or 'preview',
                job_meta.get("title") or job_meta.get("prompt", "")[:50],
                job_meta.get("prompt"),
                job_meta.get("art_style"),
                job_meta.get("model") or job_meta.get("ai_model"),
                job_meta.get("license", "private"),
                job_meta.get("symmetry_mode"),
                job_meta.get("is_a_t_pose", False),
                job_meta.get("batch_count", 1),
                job_meta.get("batch_slot"),
                job_meta.get("batch_group_id"),
                job_meta.get("lineage_root_id"),
                job_meta.get("preview_task_id") or status_data.get("preview_task_id"),
                job_meta.get("source_task_id"),
                thumbnail_url,
                status_data.get("cover_image_url"),
                100,
                created_at_ms
            ))

            # Insert into models table if we have model URLs
            if glb_url or model_urls or textured_model_urls:
                cur.execute("""
                    INSERT INTO models (
                        id, history_item_id,
                        glb_url, glb_proxy,
                        fbx_url, obj_url, usdz_url,
                        textured_glb_url, textured_fbx_url, textured_obj_url, textured_usdz_url,
                        rigged_glb_url, rigged_fbx_url,
                        texture_urls, texture_prompt,
                        enable_pbr, enable_original_uv,
                        mode, topology, target_polycount, should_remesh
                    ) VALUES (
                        %s, %s,
                        %s, %s,
                        %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        glb_url = COALESCE(EXCLUDED.glb_url, models.glb_url),
                        glb_proxy = COALESCE(EXCLUDED.glb_proxy, models.glb_proxy),
                        fbx_url = COALESCE(EXCLUDED.fbx_url, models.fbx_url),
                        obj_url = COALESCE(EXCLUDED.obj_url, models.obj_url),
                        usdz_url = COALESCE(EXCLUDED.usdz_url, models.usdz_url),
                        textured_glb_url = COALESCE(EXCLUDED.textured_glb_url, models.textured_glb_url),
                        textured_fbx_url = COALESCE(EXCLUDED.textured_fbx_url, models.textured_fbx_url),
                        textured_obj_url = COALESCE(EXCLUDED.textured_obj_url, models.textured_obj_url),
                        textured_usdz_url = COALESCE(EXCLUDED.textured_usdz_url, models.textured_usdz_url),
                        rigged_glb_url = COALESCE(EXCLUDED.rigged_glb_url, models.rigged_glb_url),
                        rigged_fbx_url = COALESCE(EXCLUDED.rigged_fbx_url, models.rigged_fbx_url),
                        texture_urls = COALESCE(EXCLUDED.texture_urls, models.texture_urls),
                        updated_at = NOW()
                """, (
                    job_id,
                    job_id,
                    glb_url,
                    f"/api/proxy-glb?u={glb_url}" if glb_url else None,
                    model_urls.get("fbx"),
                    model_urls.get("obj"),
                    model_urls.get("usdz"),
                    status_data.get("textured_glb_url") or textured_model_urls.get("glb"),
                    textured_model_urls.get("fbx"),
                    textured_model_urls.get("obj"),
                    textured_model_urls.get("usdz"),
                    status_data.get("rigged_character_glb_url"),
                    status_data.get("rigged_character_fbx_url"),
                    status_data.get("texture_urls"),
                    job_meta.get("texture_prompt"),
                    job_meta.get("enable_pbr", False),
                    job_meta.get("enable_original_uv", False),
                    status_data.get("stage") or job_meta.get("stage"),
                    job_meta.get("topology"),
                    job_meta.get("target_polycount"),
                    job_meta.get("should_remesh", False)
                ))

            # Insert thumbnail into images table
            if thumbnail_url:
                cur.execute("""
                    INSERT INTO images (
                        id, history_item_id, model_id,
                        image_url, thumbnail_url, image_type,
                        prompt
                    ) VALUES (
                        %s, %s, %s,
                        %s, %s, %s,
                        %s
                    )
                    ON CONFLICT (id) DO NOTHING
                """, (
                    f"{job_id}_thumb",
                    job_id,
                    job_id if glb_url else None,
                    thumbnail_url,
                    thumbnail_url,
                    'thumbnail',
                    job_meta.get("prompt")
                ))

        conn.close()
        print(f"[DB] Saved finished job {job_id} to normalized tables")
        return True
    except Exception as e:
        print(f"[DB] Failed to save finished job {job_id}: {e}")
        try:
            conn.close()
        except Exception:
            pass
        return False

def delete_active_job_from_db(job_id: str):
    """Remove job from active jobs table"""
    if not USE_DB:
        return
    conn = get_db_conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM active_jobs WHERE job_id = %s", (job_id,))
        conn.close()
    except Exception as e:
        print(f"[DB] Failed to delete active job {job_id}: {e}")
        try:
            conn.close()
        except Exception:
            pass

# ─────────────────────────────────────────────────────────────
# Meshy helpers
# ─────────────────────────────────────────────────────────────
def _auth_headers():
    if not MESHY_API_KEY:
        raise RuntimeError("MESHY_API_KEY not set")
    return {"Authorization": f"Bearer {MESHY_API_KEY}", "Content-Type": "application/json"}

def mesh_post(path: str, payload: dict) -> dict:
    url = f"{MESHY_API_BASE}{path}"
    r = requests.post(url, headers=_auth_headers(), json=payload, timeout=60)
    if not r.ok:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()

def mesh_get(path: str) -> dict:
    url = f"{MESHY_API_BASE}{path}"
    r = requests.get(url, headers=_auth_headers(), timeout=60)
    if not r.ok:
        raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()

# OpenAI image generation (DALL·E / GPT-Image)
def openai_image_generate(prompt: str, size: str = "1024x1024", model: str = "gpt-image-1", n: int = 1, response_format: str = "url") -> dict:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")
    url = "https://api.openai.com/v1/images/generations"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": max(1, min(4, int(n or 1))),
    }
    # gpt-image-1 doesn't support response_format parameter
    if model != "gpt-image-1":
        payload["response_format"] = response_format
    r = requests.post(url, headers=headers, json=payload, timeout=60)
    if not r.ok:
        raise RuntimeError(f"OpenAI image -> {r.status_code}: {r.text[:500]}")
    try:
        return r.json()
    except Exception:
        raise RuntimeError(f"OpenAI image returned non-JSON: {r.text[:200]}")

# ─────────────────────────────────────────────────────────────
# Utils
# ─────────────────────────────────────────────────────────────
def now_s() -> int:
    return int(time.time())

def clamp_int(value, minimum: int, maximum: int, default: int) -> int:
    try:
        return max(minimum, min(maximum, int(value)))
    except (TypeError, ValueError):
        return default

def normalize_epoch_ms(value: Any) -> int:
    """
    Accepts seconds, ms, ISO strings, or numeric-like strings and
    returns an epoch value in milliseconds.
    """
    try:
        if value is None:
            return int(time.time() * 1000)
        if isinstance(value, str):
            raw = value.strip()
            if raw.isdigit():
                value = float(raw)
            else:
                try:
                    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    return int(dt.timestamp() * 1000)
                except Exception:
                    pass
        if isinstance(value, (int, float)):
            if value > 1e15:  # looks like ns
                return int(value / 1000)
            if value < 1e12:  # looks like seconds
                return int(value * 1000)
            return int(value)
    except Exception:
        pass
    return int(time.time() * 1000)

def normalize_license(value: Any) -> str:
    raw = (str(value or "").strip().lower())
    return "cc-by-4" if raw.startswith("cc") else "private"

def _mask_value(val: Any, max_len: int = 400):
    try:
        s = json.dumps(val, ensure_ascii=False)
    except Exception:
        s = str(val)
    if len(s) > max_len:
        return s[:max_len] + "…"
    return s

def scrub_secrets(data: Any):
    """
    Recursively mask any fields that look like keys/tokens/secrets to avoid leaking.
    """
    if isinstance(data, dict):
        cleaned = {}
        for k, v in data.items():
            if any(t in k.lower() for t in ["key", "token", "secret", "auth"]):
                cleaned[k] = "***"
            else:
                cleaned[k] = scrub_secrets(v)
        return cleaned
    if isinstance(data, list):
        return [scrub_secrets(x) for x in data]
    return data

def log_event(label: str, payload: Any):
    try:
        safe_payload = scrub_secrets(payload)
        app.logger.info("[debug] %s :: %s", label, _mask_value(safe_payload))
    except Exception as e:
        app.logger.warning("[debug] %s :: failed to log (%s)", label, e)

def _task_containers(ms: dict) -> list[dict]:
    """
    Meshy responses may wrap the actual payload in `data`, `result`, or `task_result`.
    Return a list of dicts in priority order so lookups can scan through them.
    """
    containers = []
    if isinstance(ms, dict):
        containers.append(ms)
        for key in ("data", "result", "task_result"):
            val = ms.get(key)
            if isinstance(val, dict):
                containers.append(val)
            # Sometimes outputs are wrapped inside a list/dict under the same key
            if isinstance(val, list):
                containers.extend([x for x in val if isinstance(x, dict)])
        # Common extra nesting keys from Meshy payloads
        for key in ("output", "outputs"):
            val = ms.get(key)
            if isinstance(val, dict):
                containers.append(val)
            if isinstance(val, list):
                containers.extend([x for x in val if isinstance(x, dict)])
    return containers or [{}]

def _pick_first(containers: list[dict], keys: list[str], default=None):
    for c in containers:
        if not isinstance(c, dict):
            continue
        for k in keys:
            val = c.get(k)
            if val not in (None, "", []):
                return val
    return default

def extract_model_urls(ms: dict):
    """
    Meshy responses sometimes return URLs in slightly different buckets or nesting.
    Surface the ones the frontend expects to see.
    """
    containers = _task_containers(ms)
    model_urls: dict = {}
    textured_model_urls: dict = {}
    textured_glb_url = None
    rigged_glb = None
    rigged_fbx = None
    glb_candidates: list[str] = []

    def pick_url(container: dict) -> str | None:
        if not isinstance(container, dict):
            return None
        return (
            container.get("glb")
            or container.get("textured_glb")
            or container.get("textured")
            or container.get("usdz")
            or container.get("obj")
        )

    for c in containers:
        if not isinstance(c, dict):
            continue
        if not model_urls and isinstance(c.get("model_urls"), dict):
            model_urls = c.get("model_urls") or {}
        if not textured_model_urls and isinstance(c.get("textured_model_urls"), dict):
            textured_model_urls = c.get("textured_model_urls") or {}
        # Some responses put outputs in a nested "output" dict
        if not model_urls and isinstance(c.get("output_model_urls"), dict):
            model_urls = c.get("output_model_urls") or {}
        if not textured_model_urls and isinstance(c.get("output_textured_model_urls"), dict):
            textured_model_urls = c.get("output_textured_model_urls") or {}
        if not textured_glb_url and c.get("textured_glb_url"):
            textured_glb_url = c.get("textured_glb_url")
        if not rigged_glb and c.get("rigged_character_glb_url"):
            rigged_glb = c.get("rigged_character_glb_url")
        if not rigged_fbx and c.get("rigged_character_fbx_url"):
            rigged_fbx = c.get("rigged_character_fbx_url")

        glb_candidates.extend([
            url for url in [
                # Prioritize textured models for texture jobs
                c.get("textured_glb_url"),
                c.get("textured_model_url"),
                pick_url(c.get("textured_model_urls") or {}),
                # Then regular models
                c.get("glb_url"),
                c.get("model_url"),
                c.get("output_model_url"),
                c.get("mesh_url"),
                c.get("mesh_download_url"),
                c.get("gltf_url"),
                c.get("gltf_download_url"),
                c.get("usdz_url"),
                pick_url(c.get("model_urls") or {}),
                pick_url(c.get("output_model_urls") or {}),
                c.get("rigged_character_glb_url"),
            ] if url
        ])

    # Sometimes Meshy returns a bare URL as `result`; catch that.
    if not glb_candidates and isinstance(ms, dict) and isinstance(ms.get("result"), str) and ms["result"].startswith("http"):
        glb_candidates.append(ms["result"])

    # Prioritize textured models, then regular models
    glb_url = (
        textured_glb_url
        or pick_url(textured_model_urls)
        or next((u for u in glb_candidates if u), None)
        or pick_url(model_urls)
        or rigged_glb
    )

    return glb_url, model_urls, textured_model_urls, textured_glb_url, rigged_glb, rigged_fbx

def log_status_summary(route: str, job_id: str, payload: dict):
    """
    Lightweight status logging for debugging stuck jobs without being spammy.
    """
    try:
        glb_url, model_urls, textured_model_urls, textured_glb_url, rigged_glb, _ = extract_model_urls(payload or {})
        has_model = bool(glb_url or textured_glb_url or rigged_glb)
        # Also consider populated dicts as "has something"
        has_model = has_model or bool(
            (model_urls and isinstance(model_urls, dict) and any(model_urls.values())) or
            (textured_model_urls and isinstance(textured_model_urls, dict) and any(textured_model_urls.values()))
        )
        app.logger.info(
            "[status] %s job=%s status=%s pct=%s has_model=%s glb=%s",
            route,
            job_id,
            payload.get("status") or payload.get("task_status"),
            payload.get("pct") or payload.get("progress") or payload.get("progress_percentage"),
            has_model,
            (glb_url or textured_glb_url or rigged_glb or "")[:128],
        )
    except Exception as e:
        app.logger.warning("[status] %s job=%s log-failed: %s", route, job_id, e)

def normalize_status(ms: dict) -> dict:
    """
    Map Meshy task to the shape your frontend expects.
    """
    containers = _task_containers(ms)
    status_map = {
        "PENDING": "pending",
        "IN_PROGRESS": "running",
        "SUCCEEDED": "done",
        "FAILED": "failed",
        "COMPLETED": "done",
        "FINISHED": "done",
        "SUCCESS": "done",
        "CANCELED": "failed",
        "CANCELLED": "failed",
        "TIMEOUT": "failed",
    }
    st_raw = (_pick_first(containers, ["status", "task_status"]) or "").upper()
    status = status_map.get(st_raw, st_raw.lower() or "pending")
    try:
        pct = int(
            _pick_first(containers, ["progress", "progress_percentage", "progress_percent", "percent"]) or 0
        )
    except Exception:
        pct = 0
    mode = (_pick_first(containers, ["mode", "stage"]) or "").strip().lower()
    stage = "refine" if mode == "refine" else (mode or "preview")

    glb_url, model_urls, textured_model_urls, textured_glb_url, rigged_glb, rigged_fbx = extract_model_urls(ms)

    return {
        "id": _pick_first(containers, ["id", "task_id"]),
        "status": status,
        "pct": pct,
        "stage": stage,
        "thumbnail_url": _pick_first(containers, ["thumbnail_url", "cover_image_url", "image"]),
        "glb_url": glb_url,
        "model_urls": model_urls,
        "textured_model_urls": textured_model_urls,
        "textured_glb_url": textured_glb_url,
        "rigged_character_glb_url": rigged_glb,
        "rigged_character_fbx_url": rigged_fbx,
        "created_at": normalize_epoch_ms(_pick_first(containers, ["created_at", "created_at_ts", "created_time"])),
        "preview_task_id": _pick_first(containers, ["preview_task_id", "preview_task"]),
    }

def normalize_meshy_task(ms: dict, *, stage: str) -> dict:
    containers = _task_containers(ms)
    status_map = {
        "PENDING": "pending",
        "IN_PROGRESS": "running",
        "SUCCEEDED": "done",
        "FAILED": "failed",
        "CANCELED": "failed",
        "COMPLETED": "done",
        "FINISHED": "done",
        "SUCCESS": "done",
        "CANCELLED": "failed",
        "TIMEOUT": "failed",
    }
    st_raw = (_pick_first(containers, ["status", "task_status"]) or "").upper()
    status = status_map.get(st_raw, st_raw.lower() or "pending")
    try:
        pct = int(
            _pick_first(containers, ["progress", "progress_percentage", "progress_percent", "percent"]) or 0
        )
    except Exception:
        pct = 0

    glb_url, model_urls, textured_model_urls, textured_glb_url, rigged_glb, rigged_fbx = extract_model_urls(ms)

    return {
        "id": _pick_first(containers, ["id", "task_id"]),
        "status": status,
        "pct": pct,
        "stage": (_pick_first(containers, ["stage"]) or "").strip().lower() or stage,
        "thumbnail_url": _pick_first(containers, ["thumbnail_url", "cover_image_url", "image"]),
        "glb_url": glb_url,
        "model_urls": model_urls,
        "textured_model_urls": textured_model_urls,
        "textured_glb_url": textured_glb_url,
        "texture_urls": _pick_first(containers, ["texture_urls", "textures"]),
        "basic_animations": _pick_first(containers, ["basic_animations", "animations"]),
        "rigged_character_glb_url": rigged_glb,
        "rigged_character_fbx_url": rigged_fbx,
        "created_at": normalize_epoch_ms(_pick_first(containers, ["created_at", "created_at_ts", "created_time"])),
    }

def build_source_payload(body: dict):
    input_task_id = (body.get("input_task_id") or "").strip()
    model_url = (body.get("model_url") or "").strip()
    if input_task_id and model_url:
        return None, "Provide only one of input_task_id or model_url"
    if not input_task_id and not model_url:
        return None, "input_task_id or model_url required"
    return ({"input_task_id": input_task_id} if input_task_id else {"model_url": model_url}), None

# ─────────────────────────────────────────────────────────────
# API
# ─────────────────────────────────────────────────────────────
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True})

# ---- Start preview (Text → 3D) ----
@app.route("/api/text-to-3d/start", methods=["POST", "OPTIONS"])
def api_text_to_3d_start():
    if request.method == "OPTIONS":
        return ("", 204)

    body = request.get_json(silent=True) or {}
    log_event("text-to-3d/start:incoming", body)
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt required"}), 400
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503

    payload = {
        "mode": "preview",
        "prompt": prompt,
        # Meshy-6 default
        "ai_model": body.get("model") or "latest",
    }
    # pass-through options your UI may send
    art_style = body.get("art_style")
    if art_style:
        payload["art_style"] = art_style

    symmetry_mode = (body.get("symmetry_mode") or "").strip().lower()
    if symmetry_mode in {"off", "auto", "on"}:
        payload["symmetry_mode"] = symmetry_mode

    if "is_a_t_pose" in body:
        payload["is_a_t_pose"] = bool(body.get("is_a_t_pose"))

    license_choice = normalize_license(body.get("license"))
    batch_count = clamp_int(body.get("batch_count"), 1, 8, 1)
    batch_slot = clamp_int(body.get("batch_slot"), 1, batch_count, 1)
    batch_group_id = (body.get("batch_group_id") or "").strip() or None

    try:
        resp = mesh_post("/openapi/v2/text-to-3d", payload)
        log_event("text-to-3d/start:meshy-resp", resp)
        job_id = resp.get("result")
        if not job_id:
            return jsonify({"error": "No job id in response", "raw": resp}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    store = load_store()
    store[job_id] = {
        "stage": "preview",
        "prompt": prompt,
        "art_style": art_style or "realistic",
        "model": payload["ai_model"],
        "created_at": now_s() * 1000,
        "license": license_choice,
        "symmetry_mode": payload.get("symmetry_mode", "auto"),
        "is_a_t_pose": bool(body.get("is_a_t_pose")),
        "batch_count": batch_count,
        "batch_slot": batch_slot,
        "batch_group_id": batch_group_id,
    }
    save_store(store)
    return jsonify({"job_id": job_id})

# ---- Refine from preview ----
@app.route("/api/text-to-3d/refine", methods=["POST", "OPTIONS"])
def api_text_to_3d_refine():
    if request.method == "OPTIONS":
        return ("", 204)

    body = request.get_json(silent=True) or {}
    log_event("text-to-3d/refine:incoming", body)
    preview_task_id = (body.get("preview_task_id") or "").strip()
    if not preview_task_id:
        return jsonify({"error": "preview_task_id required"}), 400
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503

    payload = {
        "mode": "refine",
        "preview_task_id": preview_task_id,
        "enable_pbr": bool(body.get("enable_pbr", True)),
    }
    texture_prompt = body.get("texture_prompt")
    if texture_prompt:
        payload["texture_prompt"] = texture_prompt

    try:
        resp = mesh_post("/openapi/v2/text-to-3d", payload)
        log_event("text-to-3d/refine:meshy-resp", resp)
        job_id = resp.get("result")
        if not job_id:
            return jsonify({"error": "No job id in response", "raw": resp}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    store = load_store()
    store[job_id] = {
        "stage": "refine",
        "preview_task_id": preview_task_id,
        "created_at": now_s() * 1000,
    }
    save_store(store)
    return jsonify({"job_id": job_id})

# ---- (Soft) Remesh start (re-run preview with flags) ----
@app.route("/api/text-to-3d/remesh-start", methods=["POST", "OPTIONS"])
def api_text_to_3d_remesh_start():
    if request.method == "OPTIONS":
        return ("", 204)

    body = request.get_json(silent=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt required"}), 400
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503

    payload = {
        "mode": "preview",
        "prompt": prompt,
        "ai_model": body.get("model") or "latest",
        # mesh-friendly defaults for a cleaner topology
        "topology": "triangle",
        "should_remesh": True,
        "target_polycount": body.get("target_polycount", 45000),
        "art_style": body.get("art_style", "realistic"),
    }

    symmetry_mode = (body.get("symmetry_mode") or "").strip().lower()
    if symmetry_mode in {"off", "auto", "on"}:
        payload["symmetry_mode"] = symmetry_mode

    if "is_a_t_pose" in body:
        payload["is_a_t_pose"] = bool(body.get("is_a_t_pose"))

    license_choice = normalize_license(body.get("license"))
    batch_count = clamp_int(body.get("batch_count"), 1, 8, 1)
    batch_slot = clamp_int(body.get("batch_slot"), 1, batch_count, 1)

    try:
        resp = mesh_post("/openapi/v2/text-to-3d", payload)
        job_id = resp.get("result")
        if not job_id:
            return jsonify({"error": "No job id in response", "raw": resp}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    store = load_store()
    store[job_id] = {
        "stage": "preview",
        "prompt": prompt,
        "art_style": payload["art_style"],
        "model": payload["ai_model"],
        "created_at": now_s() * 1000,
        "remesh_like": True,
        "license": license_choice,
        "symmetry_mode": payload.get("symmetry_mode", "auto"),
        "is_a_t_pose": bool(body.get("is_a_t_pose")),
        "batch_count": batch_count,
        "batch_slot": batch_slot,
    }
    save_store(store)
    return jsonify({"job_id": job_id})

# ---- Status ----
@app.route("/api/text-to-3d/status/<job_id>", methods=["GET", "OPTIONS"])
def api_text_to_3d_status(job_id):
    if request.method == "OPTIONS":
        return ("", 204)
    log_event("text-to-3d/status:incoming", {"job_id": job_id})
    if not job_id:
        return jsonify({"error": "job_id required"}), 400
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503

    try:
        ms = mesh_get(f"/openapi/v2/text-to-3d/{job_id}")
        log_event("text-to-3d/status:meshy-resp", ms)
    except Exception as e:
        return jsonify({"error": str(e)}), 404

    out = normalize_status(ms)
    log_status_summary("text-to-3d", job_id, out)

    # persist last-known bits
    store = load_store()
    meta = store.get(job_id, {})
    # surface stored batch metadata back to caller if Meshy doesn't return it
    for key in ("batch_count", "batch_slot", "batch_group_id", "license", "symmetry_mode", "is_a_t_pose"):
        if key in meta and key not in out:
            out[key] = meta.get(key)
    meta.update({
        "last_status": out["status"],
        "last_pct": out["pct"],
        "stage": out["stage"],
    })
    if out.get("glb_url"):
        meta["glb_url"] = out["glb_url"]
    if out.get("thumbnail_url"):
        meta["thumbnail_url"] = out["thumbnail_url"]
    store[job_id] = meta
    save_store(store)

    # Save to normalized DB tables when job finishes
    if out["status"] == "done" and (out.get("glb_url") or out.get("thumbnail_url")):
        save_finished_job_to_normalized_db(job_id, out, meta, job_type='text-to-3d')

    return jsonify(out)

# ---- List active/known jobs (for resume logic) ----
@app.route("/api/text-to-3d/list", methods=["GET", "OPTIONS"])
def api_text_to_3d_list():
    if request.method == "OPTIONS":
        return ("", 204)
    store = load_store()
    items = [{"job_id": jid, **meta} for jid, meta in store.items()]
    # Keep small: only return ids (your frontend only checks presence)
    return jsonify([x["job_id"] for x in items if "job_id" in x] or list(store.keys()))

# ---- Save active job to database ----
@app.route("/api/jobs/save", methods=["POST", "OPTIONS"])
def api_save_active_job():
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        data = request.get_json() or {}
        job_id = data.get("job_id")
        job_type = data.get("job_type", "unknown")
        stage = data.get("stage")
        metadata = data.get("metadata", {})

        if not job_id:
            return jsonify({"error": "job_id required"}), 400

        success = save_active_job_to_db(job_id, job_type, stage, metadata)
        return jsonify({"success": success, "job_id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ---- Get all active jobs from database ----
@app.route("/api/jobs/active", methods=["GET", "OPTIONS"])
def api_get_active_jobs():
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        jobs = get_active_jobs_from_db()
        return jsonify(jobs)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ---- Mark job as completed ----
@app.route("/api/jobs/<job_id>/complete", methods=["POST", "OPTIONS"])
def api_complete_job(job_id):
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        mark_job_completed_in_db(job_id)
        return jsonify({"success": True, "job_id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ---- Delete active job ----
@app.route("/api/jobs/<job_id>", methods=["DELETE", "OPTIONS"])
def api_delete_active_job(job_id):
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        delete_active_job_from_db(job_id)
        return jsonify({"success": True, "job_id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ---- Proxy GLB (to avoid CORS on raw Meshy URLs) ----
@app.route("/api/proxy-glb", methods=["GET", "OPTIONS"])
def api_proxy_glb():
    if request.method == "OPTIONS":
        return ("", 204)
    u = request.args.get("u", "").strip()
    if not u:
        return jsonify({"error": "u query param required"}), 400
    # Basic allowlist: only proxy http(s)
    p = urlparse(u)
    if p.scheme not in ("http", "https"):
        abort(400)

    try:
        r = requests.get(u, stream=True, timeout=60)
    except Exception:
        abort(502)

    def gen():
        for chunk in r.iter_content(chunk_size=8192):
            if chunk:
                yield chunk

    headers = {
        "Content-Type": r.headers.get("Content-Type", "application/octet-stream"),
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
    }
    return Response(gen(), status=r.status_code, headers=headers)

# ---- Meshy Remesh ----
@app.route("/api/mesh/remesh", methods=["POST", "OPTIONS"])
def api_mesh_remesh():
    if request.method == "OPTIONS":
        return ("", 204)
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503

    body = request.get_json(silent=True) or {}
    log_event("mesh/remesh:incoming", body)
    source, err = build_source_payload(body)
    if err:
        return jsonify({"error": err}), 400

    payload = {
        **source,
        "target_formats": body.get("target_formats") or ["glb"],
    }
    topology = (body.get("topology") or "").strip().lower()
    if topology in {"triangle", "quad"}:
        payload["topology"] = topology
    try:
        tp = int(body.get("target_polycount"))
        if tp > 0:
            payload["target_polycount"] = tp
    except Exception:
        pass

    try:
        rh = float(body.get("resize_height"))
        if rh > 0:
            payload["resize_height"] = rh
    except Exception:
        pass

    origin_at = (body.get("origin_at") or "").strip().lower()
    if origin_at in {"bottom", "center"}:
        payload["origin_at"] = origin_at

    if body.get("convert_format_only") is not None:
        payload["convert_format_only"] = bool(body.get("convert_format_only"))

    try:
        resp = mesh_post("/openapi/v1/remesh", payload)
        log_event("mesh/remesh:meshy-resp", resp)
        job_id = resp.get("result") or resp.get("id")
        if not job_id:
            return jsonify({"error": "No job id in response", "raw": resp}), 502
        return jsonify({"job_id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route("/api/mesh/remesh/<job_id>", methods=["GET", "OPTIONS"])
def api_mesh_remesh_status(job_id):
    if request.method == "OPTIONS":
        return ("", 204)
    log_event("mesh/remesh/status:incoming", {"job_id": job_id})
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503
    try:
        ms = mesh_get(f"/openapi/v1/remesh/{job_id}")
        log_event("mesh/remesh/status:meshy-resp", ms)
    except Exception as e:
        return jsonify({"error": str(e)}), 404
    out = normalize_meshy_task(ms, stage="remesh")
    log_status_summary("mesh/remesh", job_id, out)

    # Save to normalized DB tables when job finishes
    if out["status"] == "done" and (out.get("glb_url") or out.get("thumbnail_url")):
        store = load_store()
        meta = store.get(job_id, {})
        save_finished_job_to_normalized_db(job_id, out, meta, job_type='remesh')

    return jsonify(out)

# ---- Meshy Retexture ----
@app.route("/api/mesh/retexture", methods=["POST", "OPTIONS"])
def api_mesh_retexture():
    if request.method == "OPTIONS":
        return ("", 204)
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503

    body = request.get_json(silent=True) or {}
    log_event("mesh/retexture:incoming", body)
    source, err = build_source_payload(body)
    if err:
        return jsonify({"error": err}), 400

    prompt = (body.get("text_style_prompt") or "").strip()
    style_img = (body.get("image_style_url") or "").strip()
    if not prompt and not style_img:
        return jsonify({"error": "text_style_prompt or image_style_url required"}), 400

    payload = {
        **source,
        "enable_original_uv": bool(body.get("enable_original_uv", True)),
        "enable_pbr": bool(body.get("enable_pbr", False)),
    }
    if prompt:
        payload["text_style_prompt"] = prompt
    if style_img:
        payload["image_style_url"] = style_img
    ai_model = (body.get("ai_model") or "").strip()
    if ai_model:
        payload["ai_model"] = ai_model

    try:
        resp = mesh_post("/openapi/v1/retexture", payload)
        log_event("mesh/retexture:meshy-resp", resp)
        job_id = resp.get("result") or resp.get("id")
        if not job_id:
            return jsonify({"error": "No job id in response", "raw": resp}), 502
        return jsonify({"job_id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route("/api/mesh/retexture/<job_id>", methods=["GET", "OPTIONS"])
def api_mesh_retexture_status(job_id):
    if request.method == "OPTIONS":
        return ("", 204)
    log_event("mesh/retexture/status:incoming", {"job_id": job_id})
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503
    try:
        ms = mesh_get(f"/openapi/v1/retexture/{job_id}")
        log_event("mesh/retexture/status:meshy-resp", ms)
    except Exception as e:
        return jsonify({"error": str(e)}), 404
    out = normalize_meshy_task(ms, stage="texture")
    log_status_summary("mesh/retexture", job_id, out)

    # Save to normalized DB tables when job finishes
    if out["status"] == "done" and (out.get("glb_url") or out.get("textured_glb_url") or out.get("thumbnail_url")):
        store = load_store()
        meta = store.get(job_id, {})
        save_finished_job_to_normalized_db(job_id, out, meta, job_type='texture')

    return jsonify(out)

# ---- Meshy Rigging ----
@app.route("/api/mesh/rigging", methods=["POST", "OPTIONS"])
def api_mesh_rigging():
    if request.method == "OPTIONS":
        return ("", 204)
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503

    body = request.get_json(silent=True) or {}
    log_event("mesh/rigging:incoming", body)
    source, err = build_source_payload(body)
    if err:
        return jsonify({"error": err}), 400

    payload = {**source}
    try:
        h = float(body.get("height_meters"))
        if h > 0:
            payload["height_meters"] = h
    except Exception:
        pass
    tex_img = (body.get("texture_image_url") or "").strip()
    if tex_img:
        payload["texture_image_url"] = tex_img

    try:
        resp = mesh_post("/openapi/v1/rigging", payload)
        log_event("mesh/rigging:meshy-resp", resp)
        job_id = resp.get("result") or resp.get("id")
        if not job_id:
            return jsonify({"error": "No job id in response", "raw": resp}), 502
        return jsonify({"job_id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route("/api/mesh/rigging/<job_id>", methods=["GET", "OPTIONS"])
def api_mesh_rigging_status(job_id):
    if request.method == "OPTIONS":
        return ("", 204)
    log_event("mesh/rigging/status:incoming", {"job_id": job_id})
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503
    try:
        ms = mesh_get(f"/openapi/v1/rigging/{job_id}")
        log_event("mesh/rigging/status:meshy-resp", ms)
    except Exception as e:
        return jsonify({"error": str(e)}), 404
    out = normalize_meshy_task(ms, stage="rig")
    log_status_summary("mesh/rigging", job_id, out)

    # Save to normalized DB tables when job finishes
    if out["status"] == "done" and (out.get("rigged_character_glb_url") or out.get("thumbnail_url")):
        store = load_store()
        meta = store.get(job_id, {})
        save_finished_job_to_normalized_db(job_id, out, meta, job_type='rig')

    return jsonify(out)

# ---- Meshy Image to 3D ----
@app.route("/api/image-to-3d/start", methods=["POST", "OPTIONS"])
def api_image_to_3d_start():
    if request.method == "OPTIONS":
        return ("", 204)
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503
    body = request.get_json(silent=True) or {}
    log_event("image-to-3d/start:incoming", body)
    image_url = (body.get("image_url") or "").strip()
    if not image_url:
        return jsonify({"error": "image_url required"}), 400
    payload = {
        "image_url": image_url,
        "prompt": (body.get("prompt") or "").strip(),
        "ai_model": body.get("model") or "latest",
        # Explicitly request textured output when supported
        "enable_pbr": True,
    }
    try:
        resp = mesh_post("/openapi/v1/image-to-3d", payload)
        log_event("image-to-3d/start:meshy-resp", resp)
        job_id = resp.get("result") or resp.get("id")
        if not job_id:
            return jsonify({"error": "No job id in response", "raw": resp}), 502
        return jsonify({"job_id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route("/api/image-to-3d/status/<job_id>", methods=["GET", "OPTIONS"])
def api_image_to_3d_status(job_id):
    if request.method == "OPTIONS":
        return ("", 204)
    log_event("image-to-3d/status:incoming", {"job_id": job_id})
    if not MESHY_API_KEY:
        return jsonify({"error": "MESHY_API_KEY not configured"}), 503
    try:
        ms = mesh_get(f"/openapi/v1/image-to-3d/{job_id}")
        log_event("image-to-3d/status:meshy-resp", ms)
    except Exception as e:
        return jsonify({"error": str(e)}), 404
    out = normalize_meshy_task(ms, stage="image3d")
    log_status_summary("image-to-3d", job_id, out)

    # Save to normalized DB tables when job finishes
    if out["status"] == "done" and (out.get("glb_url") or out.get("thumbnail_url")):
        store = load_store()
        meta = store.get(job_id, {})
        save_finished_job_to_normalized_db(job_id, out, meta, job_type='image-to-3d')

    return jsonify(out)

# ---- Nano Banana Image Generation (disabled) ----
@app.route("/api/nano/image", methods=["POST", "OPTIONS"])
def api_nano_image():
    return jsonify({"error": "NanoBanana disabled"}), 410

@app.route("/api/nano/image/<job_id>", methods=["GET", "OPTIONS"])
def api_nano_image_status(job_id):
    return jsonify({"error": "NanoBanana disabled"}), 410

# ---- OpenAI (DALL·E / GPT-Image) Image Generation ----
@app.route("/api/image/openai", methods=["POST", "OPTIONS"])
def api_openai_image():
    if request.method == "OPTIONS":
        return ("", 204)

    if not OPENAI_API_KEY:
        return jsonify({"error": "OPENAI_API_KEY not configured"}), 503

    body = request.get_json(silent=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt required"}), 400

    # normalize size
    size_raw = (body.get("size") or body.get("resolution") or "1024x1024").lower()
    size_map = {
        "256x256": "256x256",
        "512x512": "512x512",
        "1024x1024": "1024x1024",
        "1024x1792": "1024x1792",
        "1792x1024": "1792x1024",
    }
    size = "1024x1024"
    for key in size_map:
        if key in size_raw:
            size = size_map[key]
            break

    model = (body.get("model") or os.getenv("OPENAI_IMAGE_MODEL") or "gpt-image-1").strip()
    n = int(body.get("n") or 1)
    response_format = (body.get("response_format") or "url").strip()

    try:
        resp = openai_image_generate(prompt=prompt, size=size, model=model, n=n, response_format=response_format)
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    data_list = resp.get("data") or []
    urls = []
    b64_first = None
    for item in data_list:
        if not isinstance(item, dict):
            continue
        if item.get("url"):
            urls.append(item["url"])
        elif item.get("b64_json"):
            if not b64_first:
                b64_first = item["b64_json"]
            urls.append(f"data:image/png;base64,{item['b64_json']}")

    # Save to normalized DB tables
    if urls:
        image_id = f"img_{int(time.time() * 1000)}"
        save_image_to_normalized_db(
            image_id=image_id,
            image_url=urls[0],
            prompt=prompt,
            ai_model=model,
            size=size,
            image_urls=urls
        )

    return jsonify({
        "image_url": urls[0] if urls else None,
        "image_urls": urls,
        "image_base64": b64_first,
        "status": "done",
        "model": model,
        "size": size,
        "raw": resp
    })

# ---- Proxy external images (OpenAI blobs) ----
@app.route("/api/proxy-image")
def api_proxy_image():
    url = request.args.get("u") or ""
    if not url:
        return jsonify({"error": "Missing url"}), 400

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return jsonify({"error": "Invalid scheme"}), 400
    host = parsed.hostname or ""
    if host not in ALLOWED_IMAGE_HOSTS:
        return jsonify({"error": "Host not allowed"}), 400

    try:
        r = requests.get(url, stream=True, timeout=30)
    except Exception as e:
        return jsonify({"error": f"Fetch failed: {e}"}), 502

    if not r.ok:
        return jsonify({"error": f"Upstream {r.status_code}"}), r.status_code

    content_type = r.headers.get("Content-Type", "application/octet-stream")
    return Response(r.content, status=200, mimetype=content_type)

# ---- Cache base64/data: images to local files and serve via GET ----
@app.route("/api/cache-image", methods=["POST", "OPTIONS"])
def api_cache_image():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    data_url = body.get("data_url") or ""
    if not data_url.startswith("data:"):
        return jsonify({"error": "data_url is required and must be a data URI"}), 400
    try:
        header, b64data = data_url.split(",", 1)
        meta = header.split(";")[0]
        mime = meta.replace("data:", "") or "image/png"
        ext = ".png" if "png" in mime else ".jpg"
        file_id = f"{int(time.time()*1000)}"
        file_path = CACHE_DIR / f"{file_id}{ext}"
        file_path.write_bytes(base64.b64decode(b64data))
    except Exception as e:
        return jsonify({"error": f"Failed to decode data URL: {e}"}), 400

    return jsonify({
        "url": f"/api/cache-image/{file_path.name}",
        "mime": mime
    })

@app.route("/api/cache-image/<path:filename>", methods=["GET"])
def api_cache_image_get(filename):
    target = CACHE_DIR / filename
    if not target.exists():
        return jsonify({"error": "Not found"}), 404
    return Response(target.read_bytes(), mimetype="image/png")

# ---- History persistence (DATABASE PRIMARY STORAGE) ----
@app.route("/api/history", methods=["GET", "POST", "OPTIONS"])
def api_history():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "GET":
        if USE_DB:
            conn = get_db_conn()
            if conn:
                try:
                    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                        cur.execute("SELECT payload FROM history_items ORDER BY created_at DESC;")
                        rows = cur.fetchall()
                    conn.close()
                    payloads = [r["payload"] for r in rows]
                    # Keep local JSON in sync as a safety net if DB is available
                    save_history_store(payloads)
                    return jsonify(payloads)
                except Exception as e:
                    try: conn.close()
                    except Exception: pass
        return jsonify(load_history_store())

    try:
        payload = request.get_json(silent=True) or []
        if not isinstance(payload, list):
            return jsonify({"error": "Payload must be a list"}), 400

        if USE_DB:
            conn = get_db_conn()
            if conn:
                try:
                    with conn:
                        with conn.cursor() as cur:
                            for item in payload:
                                item_id = item.get("id") or item.get("job_id") or item.get("title") or str(time.time())
                                cur.execute(
                                    """INSERT INTO history_items (id, payload, updated_at)
                                       VALUES (%s, %s, NOW())
                                       ON CONFLICT (id) DO UPDATE
                                       SET payload = EXCLUDED.payload, updated_at = NOW();""",
                                    (item_id, json.dumps(item))
                                )
                    conn.close()
                except Exception:
                    try:
                        conn.close()
                    except Exception:
                        pass

        save_history_store(payload)
        return jsonify({"ok": True, "count": len(payload)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Add single history item to database
@app.route("/api/history/item", methods=["POST", "OPTIONS"])
def api_history_item_add():
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        item = request.get_json(silent=True) or {}
        item_id = item.get("id")
        if not item_id:
            return jsonify({"error": "Item ID required"}), 400

        # Always keep a copy of the ID on the payload for local fallback writes
        item["id"] = item_id
        db_ok = False

        if USE_DB:
            conn = get_db_conn()
            if conn:
                try:
                    with conn:
                        with conn.cursor() as cur:
                            cur.execute(
                                """INSERT INTO history_items (id, payload, updated_at)
                                   VALUES (%s, %s, NOW())
                                   ON CONFLICT (id) DO UPDATE
                                   SET payload = EXCLUDED.payload, updated_at = NOW();""",
                                (item_id, json.dumps(item))
                            )
                            db_ok = True
                    conn.close()
                except Exception as e:
                    try: conn.close()
                    except Exception: pass
                     # Fall through to local persistence

        local_ok = upsert_history_local(item, merge=False)
        return jsonify({"ok": True, "id": item_id, "db": db_ok, "local": local_ok})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Update single history item in database
@app.route("/api/history/item/<item_id>", methods=["PATCH", "DELETE", "OPTIONS"])
def api_history_item_update(item_id):
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "DELETE":
        db_ok = False
        if USE_DB:
            conn = get_db_conn()
            if conn:
                try:
                    with conn:
                        with conn.cursor() as cur:
                            cur.execute("DELETE FROM history_items WHERE id = %s;", (item_id,))
                    conn.close()
                    db_ok = True
                except Exception as e:
                    print(f"[History] DB delete failed for {item_id}: {e}")
                    try: conn.close()
                    except Exception: pass
        local_ok = delete_history_local(item_id)
        return jsonify({"ok": True, "deleted": item_id, "db": db_ok, "local": local_ok})

    if request.method == "PATCH":
        try:
            updates = request.get_json(silent=True) or {}
            db_ok = False
            if USE_DB:
                conn = get_db_conn()
                if conn:
                    try:
                        with conn:
                            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                                # Get existing item
                                cur.execute("SELECT payload FROM history_items WHERE id = %s;", (item_id,))
                                row = cur.fetchone()
                                if not row:
                                    return jsonify({"error": "Item not found"}), 404

                                # Merge updates
                                existing = row["payload"]
                                existing.update(updates)

                                # Save back
                                cur.execute(
                                    """UPDATE history_items
                                       SET payload = %s, updated_at = NOW()
                                       WHERE id = %s;""",
                                    (json.dumps(existing), item_id)
                                )
                        conn.close()
                        db_ok = True
                    except Exception as e:
                        print(f"[History] DB update failed for {item_id}: {e}")
                        try: conn.close()
                        except Exception: pass

            # Always persist updates to local JSON as a fallback
            existing_local = None
            arr = load_history_store()
            if isinstance(arr, list):
                for entry in arr:
                    if isinstance(entry, dict) and _local_history_id(entry) == item_id:
                        existing_local = entry
                        break
            merged_local = {**(existing_local or {}), **updates, "id": item_id}
            local_ok = upsert_history_local(merged_local, merge=True)

            return jsonify({"ok": True, "id": item_id, "db": db_ok, "local": local_ok})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

# Entrypoint
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # For Render, use: gunicorn 3dprint-backend:app
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5001")))
