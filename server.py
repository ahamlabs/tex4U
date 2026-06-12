import os
import shutil
import subprocess
import tempfile
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import uvicorn

app = FastAPI()

# Store project working directories: project_id -> path
projects = {}

class CompileRequest(BaseModel):
    source: str
    project_id: str = None

class CreateProjectRequest(BaseModel):
    mode: str = "temp"          # "temp" or "custom"
    path: Optional[str] = None  # absolute folder path for custom mode

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def index():
    return FileResponse("static/index.html")

# ---------- Project creation ----------
@app.post("/project")
async def create_project(req: CreateProjectRequest):
    """
    Create a new project.
    - mode="temp": creates a temporary directory.
    - mode="custom": uses the given absolute path as the project folder.
      The directory must exist and be writable.
    """
    project_id = os.urandom(8).hex()

    if req.mode == "temp":
        work_dir = tempfile.mkdtemp(prefix=f"latex_{project_id}_")
    elif req.mode == "custom":
        if not req.path:
            raise HTTPException(status_code=400, detail="Path required for custom mode")
        custom_path = os.path.abspath(req.path)
        if not os.path.exists(custom_path):
            raise HTTPException(status_code=400, detail="Directory does not exist")
        if not os.path.isdir(custom_path):
            raise HTTPException(status_code=400, detail="Path is not a directory")
        if not os.access(custom_path, os.W_OK):
            raise HTTPException(status_code=400, detail="Directory is not writable")
        # Use the custom path directly (no creation, user must provide existing dir)
        work_dir = custom_path
    else:
        raise HTTPException(status_code=400, detail="Invalid mode. Use 'temp' or 'custom'")

    projects[project_id] = work_dir
    return {"project_id": project_id, "mode": req.mode, "path": work_dir}

@app.post("/project/reconnect")
async def reconnect_project(req: CreateProjectRequest):
    """
    Reconnect to a custom project after server restart.
    The frontend will call this with the same path that was used before.
    Returns the (possibly new) project_id.
    """
    if req.mode != "custom" or not req.path:
        raise HTTPException(status_code=400, detail="Reconnect only works with custom mode and a path")

    custom_path = os.path.abspath(req.path)
    if not os.path.isdir(custom_path):
        raise HTTPException(status_code=400, detail="Directory not found")

    # If the path is already registered, return its existing ID
    for pid, wdir in projects.items():
        if wdir == custom_path:
            return {"project_id": pid, "mode": "custom", "path": custom_path}

    # Otherwise create a new ID for it
    project_id = os.urandom(8).hex()
    projects[project_id] = custom_path
    return {"project_id": project_id, "mode": "custom", "path": custom_path}

# ---------- Compilation ----------
@app.post("/compile")
async def compile_latex(req: CompileRequest):
    source = req.source
    if not source.strip():
        raise HTTPException(status_code=400, detail="No source provided")

    # Use existing project or create a temp one if missing
    if req.project_id and req.project_id in projects:
        project_id = req.project_id
        work_dir = projects[project_id]
    else:
        project_id = os.urandom(8).hex()
        work_dir = tempfile.mkdtemp(prefix=f"latex_{project_id}_")
        projects[project_id] = work_dir

    tex_path = os.path.join(work_dir, "document.tex")
    with open(tex_path, "w", encoding="utf-8") as f:
        f.write(source)

    try:
        for _ in range(2):
            result = subprocess.run(
                ["pdflatex", "-interaction=nonstopmode", "document.tex"],
                cwd=work_dir,
                capture_output=True,
                text=True,
                timeout=30
            )
        log = result.stdout + "\n" + result.stderr
        pdf_path = os.path.join(work_dir, "document.pdf")
        if not os.path.exists(pdf_path):
            return {"success": False, "log": log, "project_id": project_id}
        return {"success": True, "project_id": project_id, "log": log}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Compilation timed out")

# ---------- File management ----------
@app.get("/files/{project_id}")
async def list_files(project_id: str):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    work_dir = projects[project_id]
    files = []
    for fname in os.listdir(work_dir):
        if fname in ["document.tex", "document.pdf"]:
            continue
        ext = os.path.splitext(fname)[1]
        if ext in [".aux", ".log", ".out", ".toc", ".lof", ".lot", ".bbl", ".blg"]:
            continue
        path = os.path.join(work_dir, fname)
        if os.path.isfile(path):
            files.append(fname)
    return {"files": files}

@app.post("/upload/{project_id}")
async def upload_file(project_id: str, file: UploadFile = File(...)):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    work_dir = projects[project_id]
    filename = os.path.basename(file.filename)
    if not filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    dest_path = os.path.join(work_dir, filename)
    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    return {"filename": filename}

@app.delete("/files/{project_id}/{filename}")
async def delete_file(project_id: str, filename: str):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    work_dir = projects[project_id]
    filename = os.path.basename(filename)
    file_path = os.path.join(work_dir, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
    if filename in ["document.tex", "document.pdf"]:
        raise HTTPException(status_code=400, detail="Cannot delete source or PDF")
    os.remove(file_path)
    return {"deleted": filename}

# ---------- PDF serving ----------
@app.get("/pdf/{project_id}")
async def get_pdf(project_id: str):
    work_dir = projects.get(project_id)
    if not work_dir:
        raise HTTPException(status_code=404, detail="PDF not found")
    return FileResponse(os.path.join(work_dir, "document.pdf"))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)