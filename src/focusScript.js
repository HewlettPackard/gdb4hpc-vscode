// Copyright 2024 Hewlett Packard Enterprise Development LP.

//script for Focus webview panel
(function () {
  const tsvscode = acquireVsCodeApi();

  const inputField = document.getElementById('focus-input');

  //pe name input box
  var nameBox = document.createElement('INPUT');
  nameBox.setAttribute('type', 'text');
  nameBox.setAttribute('name', "focus-name");
  nameBox.setAttribute('id',   "focus-name");
  nameBox.setAttribute('value', "");
  nameBox.setAttribute('placeholder', "PE Name (Optional)");

  //procset input box
  var procBox = document.createElement('INPUT');
  procBox.setAttribute('type', 'text');
  procBox.setAttribute('name', "focus-rank");
  procBox.setAttribute('id',   "focus-rank");
  procBox.setAttribute('value', "");
  procBox.setAttribute('placeholder', "Procset");

  //select button
  var selectButton = document.createElement('button');
  selectButton.textContent='Select';
  selectButton.addEventListener('click', ()=> {
    if(nameBox.value){
      tsvscode.postMessage({
        command: 'addPe',
        name: nameBox.value,
        procset: procBox.value
      });
    }else{
      tsvscode.postMessage({
        command: 'selectedFocus',
        procset: procBox.value
      });
    }
  })

  //append to display
  inputField.appendChild(nameBox);
  inputField.appendChild(procBox);
  inputField.appendChild(selectButton);

  //update display when focus is changed
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      //when pe_list is updated, update the display
      case 'focusUpdated':
        pe_sets = message.value;
        const list = document.getElementById('focus-list');
        list.innerHTML = "";

        pe_sets.forEach((item,i) => {
          //create checkbox
          var box = document.createElement('INPUT');
          box.setAttribute('type', 'radio');
          box.setAttribute('name', "scripts");
          box.setAttribute('id',   i);
          box.setAttribute('value', item.name);
          box.checked = item.isSelected;
          box.addEventListener('change', ()=> {
            tsvscode.postMessage({
              command: 'selectedFocus',
              procset: box.value
            });
          })
          
          //create label corresponding to radio button
          var scriptLabel = document.createElement('LABEL');
          scriptLabel.setAttribute('for',item.name);
          scriptLabel.appendChild(box);
          if (item.name == item.procset){
            scriptLabel.appendChild(document.createTextNode(item.name));
          }else{
            scriptLabel.appendChild(document.createTextNode(item.name +": " +item.procset));
          }
          //create term and description tags
          var dt = document.createElement("dt");
          //focus string as dt
          dt.appendChild(scriptLabel);
          list?.append(dt);
        });
        break;
    }
  });
}());
