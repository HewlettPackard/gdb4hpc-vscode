// Copyright 2024 Hewlett Packard Enterprise Development LP.

//script for Filter webview panel
(function () {
  const tsvscode = acquireVsCodeApi();

  const inputField = document.getElementById('filter-input');

  //pe name input box
  var nameBox = document.createElement('INPUT');
  nameBox.setAttribute('type', 'text');
  nameBox.setAttribute('name', "filter-name");
  nameBox.setAttribute('id',   "filter-name");
  nameBox.setAttribute('value', "");
  nameBox.setAttribute('placeholder', "Ranks to filter");

  //procset input box
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
      procset: nameBox.value?nameBox.value:null,
      source_filter: rankBox.value?rankBox.value:null
    });
  })

  //append to display
  inputField.appendChild(nameBox);
  inputField.appendChild(rankBox);
  inputField.appendChild(selectButton);
}());
