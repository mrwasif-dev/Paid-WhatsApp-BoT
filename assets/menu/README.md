# Menu Assets Folder

Place your custom menu images and videos here!

## Supported Formats:
- **Images:** .jpg, .jpeg, .png, .gif, .webp
- **Videos:** .mp4, .mkv, .webm

## How it works:
1. Add your images/videos to this folder
2. Set `MENU_IMAGE_ASSET=true` in your `.env` file
3. The bot will randomly pick one media file for each menu display

## Priority:
1. **Assets folder** (if enabled and files exist)
2. **URL** (fallback if no assets or URL mode enabled)

## Tips:
- Use high-quality images for best results
- Video files should be short (under 30 seconds recommended)
- Name your files descriptively (e.g., `menu1.jpg`, `menu2.mp4`)
