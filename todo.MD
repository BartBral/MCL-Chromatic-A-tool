TODO:

- We need to see how the Memory-bug of the MD works exactly. As I can't seem to reproduce the "Playing a loop of adjacent Slots", I have done it twice by accident, so it is possible.

- before the actual re-pitching; if a sample is looped, and the loop is very short (length threshold set by user); then copy the data from loop and duplicate it; so the end result of the loop is X times as long as before. X also being a user-choice. 
Then set the first duplicated loop as the new loop, **before** pitching. How it is now; short one-cycle waveforms do not get rendered well; the beginning and end do not match (not even close), and because of the lack of data in the pitched sample a good one-cycle can't be made. 

- We need a feature to save samples+json file with all settings etc in a .zip-file of the whole "projects". So users can save and continue elsewhere, any time they like, without loosing all settings, edits, samples etc etc.

- start the page; by having open the settings-modal by default. Have an option in the settings where user can set if they would like to start with Settings-page or just the main-page.



Under consideration:

- edit modal needs to move to main page.
		- waveform display needs to be zoomable.
		- make distinct groups of destructive and non-destructive features.
		- destructive features (like xfade), need to have dark redisch color.
		- non-destructive features (like metadata), need to have greenish color.
	