// Copyright 2025 Hewlett Packard Enterprise Development LP.

//script for Filter webview panel
(function () {
  const tsvscode = acquireVsCodeApi();

  const inputField = document.getElementById('filter-input');

  var filterLabel = document.createElement('LABEL');
  filterLabel.setAttribute('value',"Info Filter")

  //group to filter information for input box
  var groupBox = document.createElement('INPUT');
  groupBox.setAttribute('type', 'text');
  groupBox.setAttribute('name', "filter-name");
  groupBox.setAttribute('id',   "filter-name");
  groupBox.setAttribute('value', "");
  groupBox.setAttribute('placeholder', "App0{0},App1{0}");


  var displayLabel = document.createElement('LABEL');
  displayLabel.setAttribute('value',"Source Display")

  //rank to display source code for input box
  var rankBox = document.createElement('INPUT');
  rankBox.setAttribute('type', 'number');
  rankBox.setAttribute('name', "source-rank");
  rankBox.setAttribute('id',   "source-rank");
  rankBox.setAttribute('value', "");
  rankBox.setAttribute('placeholder', "Rank");

  //rank to display source code for input box
  var appBox = document.createElement('INPUT');
  appBox.setAttribute('type', 'string');
  appBox.setAttribute('name', "source-app");
  appBox.setAttribute('id',   "source-app");
  appBox.setAttribute('value', "");
  appBox.setAttribute('placeholder', "App");

  //select button
  var selectButton = document.createElement('button');
  selectButton.textContent='Select';
  selectButton.addEventListener('click', ()=> {
    tsvscode.postMessage({
      command: 'filterGroup',
      procset: groupBox.value?groupBox.value:null,
      source_filter: rankBox.value?rankBox.value:null,
      app_filter: appBox.value?appBox.value:null
    });
  })

  //append to display
  inputField.appendChild(filterLabel);
  inputField.appendChild(groupBox);
  inputField.appendChild(displayLabel);
  inputField.appendChild(appBox);
  inputField.appendChild(rankBox);
  inputField.appendChild(selectButton);
}());
