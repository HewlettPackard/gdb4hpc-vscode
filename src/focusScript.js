// Copyright 2024 Hewlett Packard Enterprise Development LP.

//script for Focus webview panel
(function () {
  const tsvscode = acquireVsCodeApi();
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
              command: 'toggledFocus',
              id: box.id,
              checked: box.checked
            });
          })
          
          //create label corresponding to radio button
          var scriptLabel = document.createElement('LABEL');
          scriptLabel.setAttribute('for',item.name);
          scriptLabel.appendChild(box);
          scriptLabel.appendChild(document.createTextNode(item.name +": " +item.procset));
          
          //create term and description tags
          var dt = document.createElement("dt");
          //assertion string as dt
          dt.appendChild(scriptLabel);
          list?.append(dt);
        });
        break;
    }
  });
}());
