#!/home/fahim/miniconda3/bin/python
"""
ShutterMuse 4-Bit HTTP Inference Server

A high-performance FastAPI server running the 4-bit quantized ShutterMuse model
optimized for 6GB VRAM GPUs (e.g., NVIDIA RTX 4050).

Endpoints:
  1. POST /api/text          - Text & multimodal vision-language generation / chat.
  2. POST /api/pose-coco17   - Image in -> COCO-17 keypoint pose recommendation & rendered image out.
  3. POST /api/pose-upload   - Direct multipart file upload version of pose recommendation.
  4. GET  /health            - System health, model status, and VRAM utilization.
  5. GET  /docs              - Interactive Swagger OpenAPI documentation.
"""

import argparse
import base64
import io
import json
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

# Set CUDA allocator configuration before importing PyTorch
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

import cv2
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

# Standard 17 COCO Keypoints
COCO17_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]

# Standard COCO-17 skeleton limb connections (pairs of indices 0-16)
COCO17_LIMBS: List[Tuple[int, int]] = [
    (0, 1), (0, 2), (1, 3), (2, 4),           # Facial keypoints
    (5, 6),                                   # Shoulder span
    (5, 7), (7, 9),                           # Left arm
    (6, 8), (8, 10),                          # Right arm
    (5, 11), (6, 12),                         # Torso sides
    (11, 12),                                 # Hip span
    (11, 13), (13, 15),                       # Left leg
    (12, 14), (14, 16),                       # Right leg
]

# Limb BGR colors for skeleton visualization
LIMB_COLORS: List[Tuple[int, int, int]] = [
    (255, 153, 0), (255, 153, 0), (255, 153, 0), (255, 153, 0),
    (0, 255, 255),
    (0, 204, 255), (0, 153, 255),
    (255, 102, 0), (255, 51, 0),
    (102, 255, 102), (102, 255, 102),
    (0, 255, 255),
    (0, 128, 255), (0, 102, 204),
    (255, 128, 0), (204, 102, 0),
]

# Joint BGR colors
KEYPOINT_COLORS: List[Tuple[int, int, int]] = [
    (0, 255, 255),    # 0: nose (yellow)
    (255, 0, 0),      # 1: left_eye (blue)
    (255, 0, 0),      # 2: right_eye (blue)
    (0, 255, 0),      # 3: left_ear (green)
    (0, 255, 0),      # 4: right_ear (green)
    (255, 165, 0),    # 5: left_shoulder (orange)
    (255, 165, 0),    # 6: right_shoulder (orange)
    (128, 0, 128),    # 7: left_elbow (purple)
    (128, 0, 128),    # 8: right_elbow (purple)
    (255, 192, 203),  # 9: left_wrist (pink)
    (255, 192, 203),  # 10: right_wrist (pink)
    (0, 0, 255),      # 11: left_hip (red)
    (0, 0, 255),      # 12: right_hip (red)
    (0, 255, 255),    # 13: left_knee (cyan)
    (0, 255, 255),    # 14: right_knee (cyan)
    (255, 255, 0),    # 15: left_ankle (cyan)
    (255, 255, 0),    # 16: right_ankle (cyan)
]

DEFAULT_SUBJECT_PROMPT = (
    "你是一个人像摄影摆姿分析专家，请根据图片进行人像姿势推荐，以json格式给出推荐的人体17个关键点"
    "的相对坐标和是否在画面中可见，17个关键点的位置依次为：鼻子、左眼、右眼、左耳、右耳、"
    "左肩、右肩、左手肘、右肘、左手腕、右腕、左髋、右髋、左膝、右膝、左脚踝、右脚踝。"
)

# Global model state
class ModelService:
    def __init__(self, model_path: str):
        self.model_path = model_path
        self.model = None
        self.processor = None
        self.lock = threading.Lock()
        
        from transformers import AutoProcessor
        print(f"[*] Initializing ShutterMuse processor from: {self.model_path}")
        self.processor = AutoProcessor.from_pretrained(self.model_path, trust_remote_code=True)
        print("[✓] ShutterMuse processor ready. Dynamic GPU memory management active.")

    def ensure_model(self):
        """Ensures the 4-bit model is loaded in VRAM, unloading Ollama first if needed."""
        with self.lock:
            # 1. Ask Ollama to release VRAM so ShutterMuse gets full 6GB
            try:
                import urllib.request, json
                req_ps = urllib.request.Request("http://localhost:11434/api/ps")
                with urllib.request.urlopen(req_ps, timeout=2.0) as resp:
                    ps_data = json.loads(resp.read().decode("utf-8"))
                    for m in ps_data.get("models", []):
                        m_name = m.get("model") or m.get("name")
                        if m_name:
                            req_unload = urllib.request.Request(
                                "http://localhost:11434/api/generate",
                                data=json.dumps({"model": m_name, "keep_alive": 0}).encode("utf-8"),
                                headers={"Content-Type": "application/json"}
                            )
                            urllib.request.urlopen(req_unload, timeout=2.0)
            except Exception as e:
                print(f"[*] Note: Ollama VRAM cleanup: {e}")

            import gc
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                if hasattr(torch.cuda, "ipc_collect"):
                    torch.cuda.ipc_collect()

            if self.model is not None:
                return

            import transformers
            candidate_classes = [
                "Qwen3VLForConditionalGeneration",
                "Qwen2_5_VLForConditionalGeneration",
                "AutoModelForImageTextToText",
                "AutoModelForVision2Seq",
            ]
            model_cls = None
            for name in candidate_classes:
                model_cls = getattr(transformers, name, None)
                if model_cls is not None:
                    break
            if model_cls is None:
                raise ImportError(f"No suitable model class found for {candidate_classes}")

            load_kwargs: Dict[str, Any] = {"trust_remote_code": True}
            is_saved_4bit = os.path.isdir(self.model_path) and os.path.exists(
                os.path.join(self.model_path, "model.safetensors")
            )

            if is_saved_4bit:
                load_kwargs["device_map"] = {
                    "model.visual": "cpu",
                    "model.language_model": 0,
                    "lm_head": 0,
                } if torch.cuda.is_available() else "auto"
                load_kwargs["low_cpu_mem_usage"] = False
            else:
                from transformers import BitsAndBytesConfig
                load_kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=torch.float16,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_use_double_quant=True,
                    llm_int8_enable_fp32_cpu_offload=True,
                    llm_int8_skip_modules=["visual", "model.visual"],
                )
                load_kwargs["device_map"] = {
                    "model.visual": "cpu",
                    "model.language_model": 0,
                    "lm_head": 0,
                } if torch.cuda.is_available() else "auto"

            t0 = time.time()
            self.model = model_cls.from_pretrained(self.model_path, **load_kwargs)
            self.model.eval()
            print(f"[✓] ShutterMuse model loaded on GPU in {time.time() - t0:.2f}s!")

    def release_model(self):
        """Frees ShutterMuse VRAM completely right before exiting."""
        with self.lock:
            if self.model is not None:
                del self.model
                self.model = None
            import gc
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                if hasattr(torch.cuda, "ipc_collect"):
                    torch.cuda.ipc_collect()
            print("[✓] ShutterMuse VRAM completely cleared.")



def resolve_model_path(custom_path: Optional[str] = None) -> str:
    """
    Intelligently discovers the ShutterMuse-4bit model path.
    Prioritizes:
    1. User specified explicit path / CLI argument
    2. Environment variable SHUTTERMUSE_MODEL_PATH
    3. Adjacent directory 'ShutterMuse-4bit' relative to this script
    4. CWD 'ShutterMuse-4bit' or 'models/ShutterMuse-4bit'
    5. Well-known absolute location in ladducam project
    6. Fallback HuggingFace repo ID 'ShutterMuse/ShutterMuse'
    """
    candidates = []
    if custom_path:
        candidates.append(Path(custom_path))
    env_path = os.getenv("SHUTTERMUSE_MODEL_PATH")
    if env_path:
        candidates.append(Path(env_path))

    script_dir = Path(__file__).resolve().parent
    candidates.extend([
        script_dir / "ShutterMuse-4bit",
        Path.cwd() / "ShutterMuse-4bit",
        Path.cwd() / "models" / "ShutterMuse-4bit",
        Path("/home/fahim/projects/ladducam/ShutterMuse-4bit"),
    ])

    for p in candidates:
        try:
            if p.exists() and (p / "model.safetensors").exists():
                resolved = str(p.resolve())
                print(f"[✓] Located local ShutterMuse 4-bit model at: {resolved}")
                return resolved
        except Exception:
            pass

    for p in candidates:
        try:
            if p.exists() and p.is_dir():
                resolved = str(p.resolve())
                print(f"[✓] Located local model directory at: {resolved}")
                return resolved
        except Exception:
            pass

    print("[!] Local model path not found. Falling back to Hugging Face repository 'ShutterMuse/ShutterMuse'")
    return "ShutterMuse/ShutterMuse"


# Global server instance
service: Optional[ModelService] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global service
    model_path = resolve_model_path(os.getenv("SHUTTERMUSE_MODEL_PATH"))
    service = ModelService(model_path)

    def initial_warmup():
        try:
            import urllib.request, json
            req = urllib.request.Request(
                "http://localhost:11434/api/generate",
                data=json.dumps({"model": "gemma4:e2b", "prompt": "ഹലോ", "keep_alive": "15m", "stream": False}).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req, timeout=15)
            print("[✓] Initial Ollama Gemma 4 warm-up complete on 100% GPU.")
        except Exception as e:
            print(f"[*] Initial Ollama warm-up note: {e}")

    threading.Thread(target=initial_warmup, daemon=True).start()
    yield
    print("[*] Shutting down ShutterMuse service...")



app = FastAPI(
    title="ShutterMuse 4-Bit Photography Guidance API",
    description="Real-time photography composition and COCO-17 pose recommendation powered by ShutterMuse (4-bit Qwen3-VL).",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response Schemas
class TextGenerationRequest(BaseModel):
    prompt: str = Field(..., description="User prompt, question, or photography instruction.")
    system_prompt: Optional[str] = Field("You are a helpful assistant.", description="System instruction.")
    image_base64: Optional[str] = Field(None, description="Optional base64-encoded image for multimodal vision-language queries.")
    max_new_tokens: Optional[int] = Field(512, ge=16, le=2048, description="Maximum tokens to generate.")
    temperature: Optional[float] = Field(0.7, ge=0.0, le=2.0, description="Sampling temperature.")


class TextGenerationResponse(BaseModel):
    status: str
    response: str
    latency_seconds: float


class PoseRecommendationRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded JPEG/PNG/WebP image.")
    custom_prompt: Optional[str] = Field(None, description="Optional custom pose guidance prompt.")
    max_new_tokens: Optional[int] = Field(512, ge=64, le=1024, description="Max tokens for pose keypoint JSON.")
    return_format: Optional[str] = Field("json", description="'json' returns keypoints and base64 rendered image; 'image' returns raw JPEG.")


# Helper Functions
def decode_base64_image(b64_str: str) -> Image.Image:
    """Decodes a base64 string (with or without data URI prefix) into a PIL Image."""
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    image_bytes = base64.b64decode(b64_str)
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def parse_pose_json(raw_text: str) -> Dict[str, Any]:
    """Extracts JSON object from model output text using regex and json_repair."""
    try:
        import json_repair
        decoded = json_repair.loads(raw_text)
        if isinstance(decoded, dict):
            return decoded
        if isinstance(decoded, list) and len(decoded) > 0 and isinstance(decoded[0], dict):
            return decoded[0]
    except Exception:
        pass

    json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw_text, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass

    brace_match = re.search(r"(\{.*\})", raw_text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(1))
        except json.JSONDecodeError:
            pass

    # Graceful fallback if JSON parsing fails on raw text
    return {
        "instance_info": [{
            "keypoints_xyn": [],
            "visibility": [],
            "reason": raw_text.strip()
        }]
    }


def render_coco17_keypoints(
    image: np.ndarray,
    keypoints_norm: List[Tuple[float, float]],
    visibility: Optional[Union[List[int], int]] = None,
    confidences: Optional[Union[List[float], float]] = None,
    draw_labels: bool = True,
) -> np.ndarray:
    """Renders 17 COCO keypoints and connecting skeleton limbs onto an image."""
    canvas = image.copy()
    if not keypoints_norm:
        return canvas
    height, width = canvas.shape[:2]

    if visibility is None or isinstance(visibility, (int, float)):
        vis_val = int(visibility) if isinstance(visibility, (int, float)) else 1
        visibility = [vis_val] * len(keypoints_norm)
    if confidences is None or isinstance(confidences, (int, float)):
        conf_val = float(confidences) if isinstance(confidences, (int, float)) else 1.0
        confidences = [conf_val] * len(keypoints_norm)

    abs_points: List[Optional[Tuple[int, int]]] = []
    for idx, pt in enumerate(keypoints_norm):
        if not pt or len(pt) < 2:
            abs_points.append(None)
            continue
        vis = visibility[idx] if idx < len(visibility) else 1
        if vis < 0:
            abs_points.append(None)
            continue
        px = int(round(float(pt[0]) * width))
        py = int(round(float(pt[1]) * height))
        abs_points.append((px, py))

    line_thickness = max(2, int(round(max(width, height) * 0.003)))
    point_radius = max(4, int(round(max(width, height) * 0.005)))

    # 1. Draw Skeleton Limbs
    for limb_idx, (start_idx, end_idx) in enumerate(COCO17_LIMBS):
        if start_idx < len(abs_points) and end_idx < len(abs_points):
            p1 = abs_points[start_idx]
            p2 = abs_points[end_idx]
            if p1 is not None and p2 is not None:
                vis1 = visibility[start_idx] if start_idx < len(visibility) else 1
                vis2 = visibility[end_idx] if end_idx < len(visibility) else 1
                limb_color = (0, 0, 220) if (vis1 == 0 or vis2 == 0) else LIMB_COLORS[limb_idx % len(LIMB_COLORS)]
                cv2.line(canvas, p1, p2, (0, 0, 0), line_thickness + 2, cv2.LINE_AA)
                cv2.line(canvas, p1, p2, limb_color, line_thickness, cv2.LINE_AA)

    # 2. Draw Keypoints & Labels
    for idx, pt in enumerate(abs_points):
        if pt is None:
            continue
        px, py = pt
        vis = visibility[idx] if idx < len(visibility) else 1
        pt_color = (0, 0, 255) if vis == 0 else KEYPOINT_COLORS[idx % len(KEYPOINT_COLORS)]
        cv2.circle(canvas, (px, py), point_radius + 2, (0, 0, 0), -1, cv2.LINE_AA)
        cv2.circle(canvas, (px, py), point_radius, pt_color, -1, cv2.LINE_AA)

        if draw_labels:
            kp_name = COCO17_NAMES[idx]
            status_text = f"{kp_name} (v={vis})"
            font_scale = max(0.35, min(0.6, width / 2000.0))
            cv2.putText(canvas, status_text, (px + 8, py - 4), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 0, 0), 2, cv2.LINE_AA)
            cv2.putText(canvas, status_text, (px + 8, py - 4), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), 1, cv2.LINE_AA)

    return canvas


# ==============================================================================
# Endpoint 1: Text & Multimodal Chat Generation
# ==============================================================================
@app.post("/api/text", response_model=TextGenerationResponse, summary="Text & Vision-Language Generation")
async def generate_text(request: Request):
    """
    Generate conversational responses, photography advice, or analyze an optional image.
    Supports both JSON payloads and multipart/form-data with binary image file uploads.
    """
    if service is None or service.processor is None:
        raise HTTPException(status_code=503, detail="Model service is initializing.")

    from qwen_vl_utils import process_vision_info

    content_type = request.headers.get("content-type", "")
    prompt = ""
    system_prompt = "You are a professional photography tutor."
    pil_img = None
    max_new_tokens = 512
    temperature = 0.7

    if "multipart/form-data" in content_type:
        form = await request.form()
        prompt = str(form.get("prompt", ""))
        if "system_prompt" in form:
            system_prompt = str(form.get("system_prompt", system_prompt))
        if "max_new_tokens" in form:
            try:
                max_new_tokens = int(form.get("max_new_tokens", 512))
            except Exception:
                pass
        if "temperature" in form:
            try:
                temperature = float(form.get("temperature", 0.7))
            except Exception:
                pass

        # Check for image file upload (e.g. name='image', name='file', or name='data')
        img_field = form.get("image") or form.get("file") or form.get("data")
        if img_field is not None and hasattr(img_field, "read"):
            img_bytes = await img_field.read()
            if img_bytes:
                try:
                    pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                except Exception as e:
                    raise HTTPException(status_code=400, detail=f"Invalid image file: {e}")
        elif isinstance(img_field, str) and img_field:
            try:
                pil_img = decode_base64_image(img_field)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid base64 image: {e}")
        elif "image_base64" in form:
            try:
                pil_img = decode_base64_image(str(form.get("image_base64")))
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid base64 image: {e}")
    else:
        # Standard JSON body
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON request body.")
        prompt = str(body.get("prompt", ""))
        system_prompt = str(body.get("system_prompt", system_prompt))
        try:
            max_new_tokens = int(body.get("max_new_tokens", 512))
        except Exception:
            pass
        try:
            temperature = float(body.get("temperature", 0.7))
        except Exception:
            pass
        b64 = body.get("image_base64") or body.get("image")
        if b64:
            try:
                pil_img = decode_base64_image(b64)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid base64 image: {e}")

    content = []
    if pil_img is not None:
        # Cap resolution to 512x512 to preserve 6GB VRAM
        content.append({
            "type": "image",
            "image": pil_img,
            "max_pixels": 512 * 512,
            "min_pixels": 256 * 256,
        })

    content.append({"type": "text", "text": prompt})

    messages = [
        {"role": "system", "content": [{"type": "text", "text": system_prompt}]},
        {"role": "user", "content": content},
    ]

    t0 = time.time()
    service.ensure_model()
    try:
        with service.lock:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            try:
                prompt_text = service.processor.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True, enable_thinking=False
                )
            except TypeError:
                prompt_text = service.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

            image_inputs, video_inputs = process_vision_info(messages)
            inputs = service.processor(text=[prompt_text], images=image_inputs, videos=video_inputs, padding=True, return_tensors="pt")

            if torch.cuda.is_available():
                inputs = {k: (v.to("cpu") if ("pixel" in k or "image" in k) else v.to(0)) for k, v in inputs.items()}
            else:
                inputs = {k: v.to("cpu") for k, v in inputs.items()}

            gen_kwargs = {
                "max_new_tokens": max_new_tokens,
            }
            if temperature > 0.0:
                gen_kwargs["temperature"] = temperature
                gen_kwargs["do_sample"] = True
            else:
                gen_kwargs["do_sample"] = False

            with torch.no_grad():
                generated_ids = service.model.generate(**inputs, **gen_kwargs)

            generated_ids_trimmed = [
                out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs["input_ids"], generated_ids)
            ]
            response_text = service.processor.batch_decode(
                generated_ids_trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
            )[0]
    finally:
        service.release_model()

    return TextGenerationResponse(
        status="success",
        response=response_text,
        latency_seconds=round(time.time() - t0, 3),
    )


# ==============================================================================
# Endpoint 2: COCO-17 Keypoint Pose Recommendation & Image Rendering
# ==============================================================================
def process_pose_pipeline(pil_img: Image.Image, prompt_str: str, max_new_tokens: int = 512):
    """Internal core inference and rendering function for pose recommendation."""
    from qwen_vl_utils import process_vision_info

    # 1. Throttled resolution for 6GB VRAM safety
    messages = [
        {"role": "system", "content": [{"type": "text", "text": "You are a helpful assistant."}]},
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "image": pil_img,
                    "max_pixels": 512 * 512,
                    "min_pixels": 256 * 256,
                },
                {"type": "text", "text": prompt_str},
            ],
        },
    ]

    t0 = time.time()
    service.ensure_model()
    try:
        with service.lock:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            try:
                text = service.processor.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True, enable_thinking=False
                )
            except TypeError:
                text = service.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

            image_inputs, video_inputs = process_vision_info(messages)
            inputs = service.processor(text=[text], images=image_inputs, videos=video_inputs, padding=True, return_tensors="pt")

            if torch.cuda.is_available():
                inputs = {k: (v.to("cpu") if ("pixel" in k or "image" in k) else v.to(0)) for k, v in inputs.items()}
            else:
                inputs = {k: v.to("cpu") for k, v in inputs.items()}

            with torch.no_grad():
                generated_ids = service.model.generate(**inputs, max_new_tokens=max_new_tokens)

            generated_ids_trimmed = [
                out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs["input_ids"], generated_ids)
            ]
            raw_output = service.processor.batch_decode(
                generated_ids_trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
            )[0]
    finally:
        service.release_model()

    latency = round(time.time() - t0, 3)
    pose_data = parse_pose_json(raw_output)

    # Extract keypoints
    if "instance_info" in pose_data and len(pose_data["instance_info"]) > 0:
        inst = pose_data["instance_info"][0]
        kpts = inst.get("keypoints_xyn") or inst.get("keypoints") or []
        vis = inst.get("visibility") or []
        reason = inst.get("reason", "")
    else:
        kpts = pose_data.get("keypoints_xyn") or pose_data.get("keypoints") or []
        vis = pose_data.get("visibility") or []
        reason = pose_data.get("reason", "")

    # Render COCO-17 skeleton on original image
    cv_img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    rendered_bgr = render_coco17_keypoints(cv_img, kpts, vis)
    _, buffer = cv2.imencode(".jpg", rendered_bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
    jpeg_bytes = buffer.tobytes()

    return {
        "raw_output": raw_output,
        "reason": reason,
        "keypoints": kpts,
        "visibility": vis,
        "jpeg_bytes": jpeg_bytes,
        "latency_seconds": latency,
    }


@app.post("/api/pose-coco17", summary="COCO-17 Pose Recommendation (Base64 JSON)")
async def generate_pose_coco17(req: PoseRecommendationRequest):
    """
    Accepts a base64 image, generates scene-aware COCO-17 pose keypoints, and renders the skeleton.
    - Set `return_format='image'` to receive the rendered JPEG directly.
    - Set `return_format='json'` (default) to receive structured keypoints + base64 image.
    """
    if service is None or service.model is None:
        raise HTTPException(status_code=503, detail="Model is still loading.")

    try:
        pil_img = decode_base64_image(req.image_base64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to decode base64 image: {e}")

    prompt_str = req.custom_prompt or DEFAULT_SUBJECT_PROMPT
    result = process_pose_pipeline(pil_img, prompt_str, req.max_new_tokens)

    if req.return_format == "image":
        return Response(
            content=result["jpeg_bytes"],
            media_type="image/jpeg",
            headers={
                "X-Latency-Seconds": str(result["latency_seconds"]),
                "X-Keypoint-Count": str(len(result["keypoints"])),
            },
        )

    b64_rendered = base64.b64encode(result["jpeg_bytes"]).decode("utf-8")
    return {
        "status": "success",
        "reason": result["reason"],
        "keypoints_xyn": result["keypoints"],
        "visibility": result["visibility"],
        "rendered_image_base64": f"data:image/jpeg;base64,{b64_rendered}",
        "latency_seconds": result["latency_seconds"],
    }


@app.post("/api/pose-upload", summary="COCO-17 Pose Recommendation (Multipart File Upload)")
async def upload_pose_coco17(
    file: UploadFile = File(..., description="Scene image file (JPEG/PNG/WebP)"),
    return_format: str = Query("image", description="'image' for direct JPEG response, 'json' for JSON"),
    custom_prompt: Optional[str] = Form(None, description="Optional custom pose prompt"),
):
    """
    Direct file upload endpoint for testing from forms, cURL, or frontends.
    """
    if service is None or service.processor is None:
        raise HTTPException(status_code=503, detail="Model service is initializing.")

    contents = await file.read()
    try:
        pil_img = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image file: {e}")

    prompt_str = custom_prompt or DEFAULT_SUBJECT_PROMPT
    result = process_pose_pipeline(pil_img, prompt_str, max_new_tokens=512)

    if return_format == "image":
        return Response(
            content=result["jpeg_bytes"],
            media_type="image/jpeg",
            headers={
                "X-Latency-Seconds": str(result["latency_seconds"]),
                "X-Keypoint-Count": str(len(result["keypoints"])),
            },
        )

    b64_rendered = base64.b64encode(result["jpeg_bytes"]).decode("utf-8")
    return {
        "status": "success",
        "reason": result["reason"],
        "keypoints_xyn": result["keypoints"],
        "visibility": result["visibility"],
        "rendered_image_base64": f"data:image/jpeg;base64,{b64_rendered}",
        "latency_seconds": result["latency_seconds"],
    }


# ==============================================================================
# Health & Status
# ==============================================================================
@app.get("/health", summary="Health and GPU Memory Status")
async def health_check():
    gpu_info = {}
    if torch.cuda.is_available():
        gpu_info = {
            "device_name": torch.cuda.get_device_name(0),
            "allocated_mb": round(torch.cuda.memory_allocated(0) / (1024**2), 2),
            "reserved_mb": round(torch.cuda.memory_reserved(0) / (1024**2), 2),
            "total_capacity_mb": round(torch.cuda.get_device_properties(0).total_memory / (1024**2), 2),
        }

    return {
        "status": "healthy",
        "service_ready": service is not None and service.processor is not None,
        "model_loaded_in_vram": service is not None and service.model is not None,
        "model_path": service.model_path if service else None,
        "gpu": gpu_info,
    }


@app.get("/", summary="Root Welcome & Documentation Link")
async def root():
    return {
        "message": "ShutterMuse 4-Bit Photography Guidance Server is running.",
        "endpoints": {
            "text_generation": "POST /api/text",
            "pose_recommendation_json": "POST /api/pose-coco17",
            "pose_recommendation_upload": "POST /api/pose-upload",
            "health": "GET /health",
            "interactive_docs": "GET /docs",
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run ShutterMuse 4-bit HTTP server")
    parser.add_argument(
        "--host",
        type=str,
        default=os.getenv("SHUTTERMUSE_HOST", "0.0.0.0"),
        help="Host interface (default: 0.0.0.0 or $SHUTTERMUSE_HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("SHUTTERMUSE_PORT", "8000")),
        help="Port to bind server (default: 8000 or $SHUTTERMUSE_PORT)",
    )
    parser.add_argument(
        "--model-path",
        type=str,
        default=None,
        help="Path to 4-bit model or Hugging Face repo ID (auto-discovered if omitted)",
    )
    args = parser.parse_args()

    model_path = resolve_model_path(args.model_path)
    os.environ["SHUTTERMUSE_MODEL_PATH"] = model_path
    print(f"[*] Starting ShutterMuse API server on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
