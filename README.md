# GDB4HPC EXTENSION

A VSCode extension that provides support for debugging applications with gdb4hpc.

## Development Instructions

### Set up
Clone this repository onto your machine. In the repository directory run `npm i` to install all dependencies 
needed for this project from the package.json file.

### Packaging
Run `npm run package` to compile and package everything into a vsix file.

### Installing Extension from VSIX File
Open VSCode on the machine with GDB4HPC and confirm the vsix file is on the machine as well.
In VSCode choose `Extensions -> ... -> Install from VSIX...` 
Choose the vsix file and reload the window if prompted.