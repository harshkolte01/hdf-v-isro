"""
HDF Viewer Backend - Main Application
"""

import logging
import os
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.DEBUG if os.getenv("DEBUG", "False").lower() == "true" else logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)
app.url_map.strict_slashes = False

# CORS configuration — open wildcard for development; restrict origins in production
CORS(
    app,
    resources={r"/*": {"origins": "*"}},
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.route("/", methods=["GET"])
def index():
    """Simple service info endpoint."""
    return jsonify(
        {
            "service": "HDF Viewer Backend",
            "status": "running",
            "health": "/health",
            "files": "/files/",
        }
    ), 200


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    logger.info("Health check requested")
    return jsonify(
        {
            "status": "healthy",
            "timestamp": datetime.utcnow().isoformat(),
            "service": "HDF Viewer Backend",
        }
    ), 200


# Register blueprints — files_bp handles listing/refresh; hdf5_bp handles HDF5 navigation
# Both are mounted under /files so the tree endpoints stay at /files/<key>/children etc.
from src.routes.files import files_bp
from src.routes.hdf5 import hdf5_bp

app.register_blueprint(files_bp, url_prefix="/files")
app.register_blueprint(hdf5_bp, url_prefix="/files")

logger.info("Routes registered successfully")


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("DEBUG", "False").lower() == "true"

    logger.info("Starting server on %s:%s (debug=%s)", host, port, debug)
    app.run(host=host, port=port, debug=debug)
