# Development Instructions

# Set up
Clone this repository onto your machine. In the repository directory run `npm i` to install all dependencies 
needed for this project from the package.json file.

# Packaging
Run `npm run package` to compile and package everything into a vsix file.

# Installing Extension from local VSIX File
Open VSCode on the machine with GDB4HPC and confirm the vsix file is on the machine as well.
In VSCode choose `Extensions -> ... -> Install from VSIX...` 
Choose the vsix file and reload the window if prompted.

# Using VSCode Development Host
Open a vscode window (window #1) and open the root of the cdst-gdb4hpc-vscode repository. Make sure this repository is the root of the Workspace in this vscode window.

In the "Run and Debug" section, you will see "Run Extension" available in the drop down on the top. Press the play button next to it. This should open a new vscode window (window #2) with the development host.

Window #1 will now allow you to debug the extension by creating breakpoints in the extension code located under "src" directory and display local variables, call stacks, etc.

Window #2 will allow you to run your extension to simulate a user. In window #2 create a workspace for the code you will be running. Setup the workspace with a .vscode/launch.json configured to run the gdb4hpc extension and the program to be debugged. Once ready, run this extension using the "Run and Debug" section similarily to window #1. Once a breakpoint is hit in the extension development code, you should see the program stop and window #1 will come back into focus with the breakpoint displayed.

## Problems with development

### Breakpoints are "unbound"
If breakpoints are not being hit in your extension code, the source map might be set up incorrectly. Make sure ```tsconfig.json``` is set up correctly. 

"outDir": "dist",
"sourceMap": true,
"rootDir": "src",

Typescript has to have a sourcemap to correctly map the compiled js code back to the ts source. 

```rootDir``` is pointing to the directory containing all of the extension source files. 

```sourceMap``` should be set to true to allow everything to be mapped correctly. 

```outDir``` needs to point to the directory that has the compiled js code. 

```Run extension``` should recompile all of the code automatically before it starts running. You can do the same manually by running the ```npm run compile``` command.

