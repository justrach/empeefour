.PHONY: smoke editor

smoke:
	python3 -m compileall studio_agent
	mkdir -p runs/smoke
	ffmpeg -hide_banner -y -f lavfi -i testsrc2=size=1280x720:rate=30:duration=3 -pix_fmt yuv420p runs/smoke/raw.mov
	cp examples/smoke-events.json runs/smoke/events.json
	python3 -m studio_agent render runs/smoke --output runs/smoke/final.mp4 --preset ultrafast --canvas 1920x1080

editor:
	python3 -m studio_agent editor --port 8765
