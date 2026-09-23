This is just a small kwin script I put togther for having quick access to TUI app (currently spotify_player). It's fairly simple and just handles showing/hiding and keeping track of what window was focused before for a smooth workflow. Previously the animation was a pretty cool slide out that was way over the top, but that was causing issues with the tui flickering due to my monitors having different scaling. Instead it's just a fade in/out now :(



You can install it through the cli with:

// to package it
kpackagetool6 --type=KWin/Script -i ~/Popup/main.js

// and this to enable it
kwriteconfig6 --file kwinrc --group Plugins --key tmux-popup true
qdbus org.kde.KWin /KWin reconfigure

Or through the pre packaged kwinscript archive [RECOMMENDED]

The script relies on a window(Kitty in my case) being launched with it's resource name/class as tmux-popup. You can see an example of how I made a func in fish to launch this in the repo.
