// Copyright 2025 Hewlett Packard Enterprise Development LP.

//script for Filter webview panel
(function () {
  const tsvscode = acquireVsCodeApi();

  const inputField = document.getElementById('filter-input');

  //group to filter information for input box
  var groupBox = document.createElement('INPUT');
  groupBox.setAttribute('type', 'text');
  groupBox.setAttribute('name', "filter-name");
  groupBox.setAttribute('id',   "filter-name");
  groupBox.setAttribute('value', "");
  groupBox.setAttribute('placeholder', "Ranks to filter");

  //rank to display source code for input box
  var rankBox = document.createElement('INPUT');
  rankBox.setAttribute('type', 'number');
  rankBox.setAttribute('name', "source-rank");
  rankBox.setAttribute('id',   "source-rank");
  rankBox.setAttribute('value', "");
  rankBox.setAttribute('placeholder', "Rank to display");

  //select button
  var selectButton = document.createElement('button');
  selectButton.textContent='Select';
  selectButton.addEventListener('click', ()=> {
    tsvscode.postMessage({
      command: 'filterGroup',
      procset: groupBox.value?groupBox.value:null,
      source_filter: rankBox.value?rankBox.value:null
    });
  })

  //append to display
  inputField.appendChild(groupBox);
  inputField.appendChild(rankBox);
  inputField.appendChild(selectButton);
}());
