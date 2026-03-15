"""
YouTube Transcript Server
Run: python server.py
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled

app = Flask(__name__)
CORS(app, origins=["chrome-extension://*"])


@app.route("/transcript")
def get_transcript():
    video_id = request.args.get("v")
    lang = request.args.get("lang", "ko")

    if not video_id:
        return jsonify({"error": "video_id가 필요합니다."}), 400

    try:
        # Try requested language first, then Korean, then English, then any
        segments = YouTubeTranscriptApi.get_transcript(
            video_id, languages=[lang, "ko", "en"]
        )
    except NoTranscriptFound:
        try:
            # Fall back to auto-generated captions in any language
            transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
            transcript = transcript_list.find_generated_transcript(
                [lang, "ko", "en"]
            )
            segments = transcript.fetch()
        except Exception as e:
            return jsonify({"error": f"자막 없음: {str(e)}"}), 404
    except TranscriptsDisabled:
        return jsonify({"error": "이 영상은 자막이 비활성화되어 있습니다."}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"segments": segments})


if __name__ == "__main__":
    print("YouTube Transcript Server 시작 (http://localhost:5000)")
    app.run(port=5000)
